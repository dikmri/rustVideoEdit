// プロジェクト状態 + 操作アクション(DESIGN.md §4 データモデルのモデル操作ロジック一式)。
// P3 の Timeline UI 等はこのストアの関数を呼ぶだけにする(モデル操作ロジックはここに集約)。
import { create } from "zustand";
import { useStore } from "zustand";
import { temporal } from "zundo";

import type { Clip, MediaAsset, MosaicKeyframe, MosaicRegion, Project, ProjectSettings, Track } from "../types/model";
import { log } from "../lib/logger";
import {
  MOSAIC_BLOCK_SIZE_DEFAULT,
  MOSAIC_BLOCK_SIZE_MAX,
  MOSAIC_BLOCK_SIZE_MIN,
  sameTimeTolerance,
  upsertKeyframe,
} from "../lib/mosaic";
import { useUIStore } from "./uiStore";

/** 動画/画像/テキストクリップの最小長(秒)。 */
const MIN_DURATION = 0.1;
/** 浮動小数点誤差吸収用の許容値。 */
const EPS = 1e-6;

// ---------------------------------------------------------------------------
// 内部ヘルパ
// ---------------------------------------------------------------------------

function makeTrack(kind: "video" | "audio", name: string): Track {
  return { id: crypto.randomUUID(), kind, name, locked: false, muted: false, clips: [] };
}

function createDefaultProject(): Project {
  return {
    version: 1,
    name: "無題のプロジェクト",
    settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000 },
    assets: [],
    videoTracks: [makeTrack("video", "V1"), makeTrack("video", "V2")],
    audioTracks: [makeTrack("audio", "A1"), makeTrack("audio", "A2")],
  };
}

/** テキストスタイルの既定値(§14.2 拡張フィールド)。既定は縁取り/影なし。 */
const DEFAULT_TEXT_STYLE_EXTRA = {
  outlineColor: null as string | null,
  outlineWidth: 0,
  shadowColor: null as string | null,
  shadowX: 2,
  shadowY: 2,
  lineSpacing: 0,
};

/**
 * 旧バージョンの .rvep で欠落しているフィールドを既定値で補完する(§13.2, §13.5, §14.4)。
 * v0.2.0 で MediaAsset に追加された bitrateKbps が無い場合は null を、
 * Clip に追加された mosaics が無い場合は [] を、transitionIn が無い場合は null を、
 * TextStyle の新規フィールドが無い場合は既定値を入れる。
 */
function normalizeProject(project: Project): Project {
  project.assets = project.assets.map((asset) => ({
    ...asset,
    bitrateKbps: (asset as Partial<MediaAsset>).bitrateKbps ?? null,
  }));
  for (const track of [...project.videoTracks, ...project.audioTracks]) {
    track.clips = track.clips.map((clip) => ({
      ...clip,
      mosaics: (clip as Partial<Clip>).mosaics ?? [],
      transitionIn: (clip as Partial<Clip>).transitionIn ?? null,
      text: clip.text ? { ...DEFAULT_TEXT_STYLE_EXTRA, ...clip.text } : null,
    }));
  }
  return project;
}

/** MosaicRegion[] のディープコピー(splitClip の複製用)。 */
function cloneMosaics(mosaics: MosaicRegion[]): MosaicRegion[] {
  return mosaics.map((r) => ({ ...r, keyframes: r.keyframes.map((k) => ({ ...k })) }));
}

function findTrackById(project: Project, trackId: string): Track | null {
  return (
    project.videoTracks.find((t) => t.id === trackId) ??
    project.audioTracks.find((t) => t.id === trackId) ??
    null
  );
}

function findAssetById(project: Project, assetId: string): MediaAsset | null {
  return project.assets.find((a) => a.id === assetId) ?? null;
}

/** importSrtCues に渡すキュー(§14.2)。lib/srt.ts の SrtCue と同形(store は srt.ts に依存しない)。 */
export interface SrtCueInput {
  start: number;
  end: number;
  text: string;
}

interface ClipLocation {
  track: Track;
  clip: Clip;
  index: number;
}

function findClipLocation(project: Project, clipId: string): ClipLocation | null {
  for (const track of [...project.videoTracks, ...project.audioTracks]) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index !== -1) {
      return { track, clip: track.clips[index], index };
    }
  }
  return null;
}

function computeTimelineDuration(project: Project): number {
  let max = 0;
  for (const track of [...project.videoTracks, ...project.audioTracks]) {
    for (const clip of track.clips) {
      max = Math.max(max, clip.start + clip.duration);
    }
  }
  return max;
}

/** クリップを start 昇順を保ったまま挿入する。 */
function insertClipSorted(clips: Clip[], clip: Clip): void {
  let idx = clips.findIndex((c) => c.start > clip.start);
  if (idx === -1) idx = clips.length;
  clips.splice(idx, 0, clip);
}

interface Gap {
  start: number;
  end: number; // Infinity 可
}

/** clips(対象クリップ自身は含まない)から空いている区間の一覧を start 昇順で求める。 */
function computeGaps(clips: Clip[]): Gap[] {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const gaps: Gap[] = [];
  let cursor = 0;
  for (const c of sorted) {
    if (c.start > cursor + EPS) gaps.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.start + c.duration);
  }
  gaps.push({ start: cursor, end: Infinity });
  return gaps;
}

/**
 * 重なり禁止ルール(DESIGN §4)に基づき、`otherClips` と重ならない開始位置を求める。
 * 望ましい位置 `desiredStart` に最も近い、`duration` が収まる区間へクランプする。
 * 末尾には常に無限区間が存在するため、必ずいずれかの区間が見つかる。
 */
function clampToNonOverlapping(otherClips: Clip[], desiredStart: number, duration: number): number {
  const gaps = computeGaps(otherClips);
  const ds = Math.max(0, desiredStart);
  let best: { start: number; dist: number } | null = null;
  for (const gap of gaps) {
    const gapLen = gap.end === Infinity ? Infinity : gap.end - gap.start;
    if (gapLen + EPS < duration) continue;
    const upper = gap.end === Infinity ? Infinity : gap.end - duration;
    const s = Math.min(Math.max(ds, gap.start), upper);
    const dist = Math.abs(s - ds);
    if (best === null || dist < best.dist) best = { start: s, dist };
  }
  return best ? best.start : ds;
}

function markDirty(): void {
  useUIStore.getState().setDirty(true);
}

interface Cancelable {
  cancel: () => void;
}

/**
 * zundo の `handleSet` に渡すデバウンス関数(DESIGN §9: 300ms デバウンス)。
 * `cancel()` で保留中の呼び出しを破棄できる(newProject/loadProject 直後の
 * 履歴クリアが、既に予約済みの遅延 push によって無効化されるのを防ぐため)。
 */
function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): T & Cancelable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = ((...args: Parameters<T>) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, wait);
  }) as T & Cancelable;
  debounced.cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return debounced;
}

/** temporal の handleSet に渡した実体への参照(clearHistory から cancel するため)。 */
let debouncedHandleSetRef: Cancelable | null = null;

// ---------------------------------------------------------------------------
// ストア定義
// ---------------------------------------------------------------------------

export interface ProjectState {
  project: Project;

  newProject: () => void;
  loadProject: (project: Project) => void;

  setProjectName: (name: string) => void;
  setSettings: (partial: Partial<ProjectSettings>) => void;

  addAsset: (asset: MediaAsset) => void;
  removeAsset: (assetId: string) => void;

  addTrack: (kind: "video" | "audio") => string;
  removeTrack: (trackId: string) => void;
  renameTrack: (trackId: string, name: string) => void;
  setTrackLocked: (trackId: string, locked: boolean) => void;
  setTrackMuted: (trackId: string, muted: boolean) => void;

  addClipFromAsset: (assetId: string, trackId: string, start: number) => string | null;
  addTextClip: (trackId: string, start: number) => string | null;
  moveClip: (clipId: string, newTrackId: string, newStart: number) => void;
  trimClip: (clipId: string, edge: "left" | "right", newTime: number) => void;
  splitClip: (clipId: string, atTime: number) => void;
  removeClip: (clipId: string) => void;
  rippleDelete: (clipId: string) => void;
  updateClip: (clipId: string, partial: Partial<Clip>) => void;

  /** video クリップ(hasAudio)の音声を audio トラックへ切り離す(§14.3)。単一 mutate で undo 一回。 */
  detachAudio: (clipId: string) => string | null;
  /** SRT キューをテキストクリップ群として新規 video トラックに配置する(§14.2)。単一 mutate で undo 一回。 */
  importSrtCues: (cues: SrtCueInput[]) => { trackId: string; count: number } | null;

  /** モザイク領域を追加し、新規領域の id を返す(§13.2)。time はクリップローカル秒。 */
  addMosaicRegion: (clipId: string, time: number) => string | null;
  removeMosaicRegion: (clipId: string, regionId: string) => void;
  setMosaicRegionProps: (
    clipId: string,
    regionId: string,
    props: Partial<Pick<MosaicRegion, "enabled" | "blockSize">>,
  ) => void;
  /** キーフレームを挿入/更新する(±半フレーム以内の既存キーフレームがあれば更新)。 */
  upsertMosaicKeyframe: (clipId: string, regionId: string, kf: MosaicKeyframe) => void;
  removeMosaicKeyframe: (clipId: string, regionId: string, index: number) => void;

  getClipById: (clipId: string) => Clip | null;
  getTrackOfClip: (clipId: string) => Track | null;
  getTimelineDuration: () => number;
}

export const useProjectStore = create<ProjectState>()(
  temporal(
    (set, get) => {
      /** project のドラフトを作り、fn が true を返した場合のみ確定+dirty化する。 */
      function mutate(fn: (draft: Project) => boolean): void {
        const draft = structuredClone(get().project);
        if (fn(draft)) {
          set({ project: draft });
          markDirty();
        }
      }

      return {
        project: createDefaultProject(),

        newProject: () => set({ project: createDefaultProject() }),
        loadProject: (project) => set({ project: normalizeProject(structuredClone(project)) }),

        setProjectName: (name) =>
          mutate((project) => {
            if (project.name === name) return false;
            project.name = name;
            return true;
          }),

        setSettings: (partial) =>
          mutate((project) => {
            project.settings = { ...project.settings, ...partial };
            return true;
          }),

        addAsset: (asset) =>
          mutate((project) => {
            project.assets.push(asset);
            return true;
          }),

        removeAsset: (assetId) =>
          mutate((project) => {
            const hadAsset = project.assets.some((a) => a.id === assetId);
            project.assets = project.assets.filter((a) => a.id !== assetId);
            for (const track of [...project.videoTracks, ...project.audioTracks]) {
              track.clips = track.clips.filter((c) => c.assetId !== assetId);
            }
            return hadAsset;
          }),

        addTrack: (kind) => {
          const id = crypto.randomUUID();
          mutate((project) => {
            const list = kind === "video" ? project.videoTracks : project.audioTracks;
            const prefix = kind === "video" ? "V" : "A";
            list.push({ id, kind, name: `${prefix}${list.length + 1}`, locked: false, muted: false, clips: [] });
            return true;
          });
          return id;
        },

        removeTrack: (trackId) =>
          mutate((project) => {
            const before = project.videoTracks.length + project.audioTracks.length;
            project.videoTracks = project.videoTracks.filter((t) => t.id !== trackId);
            project.audioTracks = project.audioTracks.filter((t) => t.id !== trackId);
            return project.videoTracks.length + project.audioTracks.length !== before;
          }),

        renameTrack: (trackId, name) =>
          mutate((project) => {
            const track = findTrackById(project, trackId);
            if (!track || track.name === name) return false;
            track.name = name;
            return true;
          }),

        setTrackLocked: (trackId, locked) =>
          mutate((project) => {
            const track = findTrackById(project, trackId);
            if (!track || track.locked === locked) return false;
            track.locked = locked;
            return true;
          }),

        setTrackMuted: (trackId, muted) =>
          mutate((project) => {
            const track = findTrackById(project, trackId);
            if (!track || track.muted === muted) return false;
            track.muted = muted;
            return true;
          }),

        addClipFromAsset: (assetId, trackId, start) => {
          let newId: string | null = null;
          mutate((project) => {
            const asset = findAssetById(project, assetId);
            const track = findTrackById(project, trackId);
            if (!asset || !track) return false;
            if (track.locked) return false; // ロック済みトラックへの追加は不可
            // video/image/text → video トラックのみ、audio → audio トラックのみ。
            // 音声付き video アセットも video トラック専用(§4)。
            const wantsVideoTrack = asset.kind !== "audio";
            const compatible = wantsVideoTrack ? track.kind === "video" : track.kind === "audio";
            if (!compatible) return false;

            const duration = asset.kind === "image" ? 5 : asset.duration;
            if (duration <= 0) return false;

            const id = crypto.randomUUID();
            const clampedStart = clampToNonOverlapping(track.clips, Math.max(0, start), duration);
            const clip: Clip = {
              id,
              assetId,
              start: clampedStart,
              duration,
              inPoint: 0,
              speed: 1,
              volume: 1,
              muted: false,
              opacity: 1,
              transform: { x: 0, y: 0, scale: 1, rotation: 0 },
              fadeIn: 0,
              fadeOut: 0,
              effects: [],
              text: null,
              mosaics: [],
              transitionIn: null,
            };
            insertClipSorted(track.clips, clip);
            newId = id;
            return true;
          });
          return newId;
        },

        addTextClip: (trackId, start) => {
          let newId: string | null = null;
          mutate((project) => {
            const track = findTrackById(project, trackId);
            if (!track || track.kind !== "video" || track.locked) return false;

            const duration = 5; // DESIGN 未規定のため画像既定と同じ 5 秒を採用
            const id = crypto.randomUUID();
            const clampedStart = clampToNonOverlapping(track.clips, Math.max(0, start), duration);
            const clip: Clip = {
              id,
              assetId: null,
              start: clampedStart,
              duration,
              inPoint: 0,
              speed: 1,
              volume: 1,
              muted: false,
              opacity: 1,
              transform: { x: 0, y: 0, scale: 1, rotation: 0 },
              fadeIn: 0,
              fadeOut: 0,
              effects: [],
              text: {
                content: "テキスト",
                fontFamily: "Meiryo",
                fontSize: 64,
                color: "#FFFFFF",
                bold: false,
                align: "center",
                background: null,
                ...DEFAULT_TEXT_STYLE_EXTRA,
              },
              mosaics: [],
              transitionIn: null,
            };
            insertClipSorted(track.clips, clip);
            newId = id;
            return true;
          });
          return newId;
        },

        moveClip: (clipId, newTrackId, newStart) =>
          mutate((project) => {
            const loc = findClipLocation(project, clipId);
            const newTrack = findTrackById(project, newTrackId);
            if (!loc || !newTrack) return false;
            if (loc.track.kind !== newTrack.kind) return false; // 同種トラック間のみ
            if (loc.track.locked || newTrack.locked) return false; // ロック済みトラックは移動元/先どちらも不可

            loc.track.clips.splice(loc.index, 1);
            const clampedStart = clampToNonOverlapping(newTrack.clips, Math.max(0, newStart), loc.clip.duration);
            const movedClip: Clip = { ...loc.clip, start: clampedStart };
            insertClipSorted(newTrack.clips, movedClip);
            return true;
          }),

        trimClip: (clipId, edge, newTime) =>
          mutate((project) => {
            const loc = findClipLocation(project, clipId);
            if (!loc) return false;
            const { track, clip, index } = loc;
            const asset = clip.assetId ? findAssetById(project, clip.assetId) : null;
            // 実尺を持つソース(動画・音声)はソース範囲外へ延長できない。画像・テキストは自由。
            const isVideoAsset = asset !== null && asset.kind !== "image";
            const prev = index > 0 ? track.clips[index - 1] : null;
            const next = index < track.clips.length - 1 ? track.clips[index + 1] : null;

            if (edge === "left") {
              const oldEnd = clip.start + clip.duration;
              const lowerBound = prev ? prev.start + prev.duration : 0;
              let newStart = Math.min(Math.max(newTime, lowerBound), oldEnd - MIN_DURATION);
              if (isVideoAsset) {
                // inPoint がマイナスにならない範囲でのみ左へ延長できる。
                const minStartByInPoint = clip.start - clip.inPoint / clip.speed;
                newStart = Math.max(newStart, minStartByInPoint);
                newStart = Math.min(newStart, oldEnd - MIN_DURATION);
                const delta = newStart - clip.start;
                clip.inPoint = clip.inPoint + delta * clip.speed;
              }
              if (Math.abs(newStart - clip.start) < EPS) return false;
              clip.duration = oldEnd - newStart;
              clip.start = newStart;
              return true;
            } else {
              const upperBoundNext = next ? next.start : Infinity;
              let newEnd = Math.max(Math.min(newTime, upperBoundNext), clip.start + MIN_DURATION);
              if (isVideoAsset && asset) {
                const maxEnd = clip.start + (asset.duration - clip.inPoint) / clip.speed;
                newEnd = Math.min(newEnd, maxEnd);
                newEnd = Math.max(newEnd, clip.start + MIN_DURATION);
              }
              const newDuration = newEnd - clip.start;
              if (Math.abs(newDuration - clip.duration) < EPS) return false;
              clip.duration = newDuration;
              return true;
            }
          }),

        splitClip: (clipId, atTime) =>
          mutate((project) => {
            const loc = findClipLocation(project, clipId);
            if (!loc) return false;
            const { track, clip, index } = loc;
            const start = clip.start;
            const end = clip.start + clip.duration;
            // 分割後の両クリップが最小長を確保できない場合は分割しない。
            if (atTime <= start + MIN_DURATION || atTime >= end - MIN_DURATION) return false;

            const leftDuration = atTime - start;
            const rightDuration = end - atTime;
            const rightInPoint = clip.inPoint + leftDuration * clip.speed;

            const leftClip: Clip = {
              ...clip,
              duration: leftDuration,
              fadeOut: 0,
              transform: { ...clip.transform },
              effects: clip.effects.map((e) => ({ ...e })),
              text: clip.text ? { ...clip.text } : null,
              mosaics: cloneMosaics(clip.mosaics),
            };
            // 右側クリップ: キーフレーム time はクリップローカル秒(§13.2)のため
            // -leftDuration シフトする。time<0 になったものもホールド動作が保たれるよう
            // そのまま残す(sampleRegion は先頭より前をホールドするので挙動は同じ)。
            // transitionIn(§14.1)は左クリップのみ引き継ぎ、右は null にする
            // (分割で生まれた新しい先頭には「入りのトランジション」の意味論が無いため)。
            const rightClip: Clip = {
              ...clip,
              id: crypto.randomUUID(),
              start: atTime,
              duration: rightDuration,
              inPoint: rightInPoint,
              fadeIn: 0,
              transform: { ...clip.transform },
              effects: clip.effects.map((e) => ({ ...e })),
              text: clip.text ? { ...clip.text } : null,
              mosaics: cloneMosaics(clip.mosaics).map((r) => ({
                ...r,
                keyframes: r.keyframes.map((k) => ({ ...k, time: k.time - leftDuration })),
              })),
              transitionIn: null,
            };

            track.clips.splice(index, 1, leftClip, rightClip);
            return true;
          }),

        removeClip: (clipId) =>
          mutate((project) => {
            const loc = findClipLocation(project, clipId);
            if (!loc) return false;
            loc.track.clips.splice(loc.index, 1);
            return true;
          }),

        rippleDelete: (clipId) =>
          mutate((project) => {
            const loc = findClipLocation(project, clipId);
            if (!loc) return false;
            const { track, clip } = loc;
            const removedStart = clip.start;
            const removedDuration = clip.duration;
            track.clips = track.clips
              .filter((c) => c.id !== clipId)
              .map((c) => (c.start > removedStart ? { ...c, start: c.start - removedDuration } : c));
            return true;
          }),

        updateClip: (clipId, partial) =>
          mutate((project) => {
            const loc = findClipLocation(project, clipId);
            if (!loc) return false;
            const { track, clip, index } = loc;
            const asset = clip.assetId ? findAssetById(project, clip.assetId) : null;
            const isFixedSpeed = clip.assetId === null || asset?.kind === "image";

            const merged: Clip = { ...clip, ...partial };

            if (isFixedSpeed) {
              merged.speed = 1;
            } else if (partial.speed !== undefined && partial.speed !== clip.speed) {
              const newSpeed = Math.min(4, Math.max(0.25, partial.speed));
              // 動画・音声はソース実尺で duration をクランプする(画像は isFixedSpeed で除外済み)。
              const isVideoAsset = asset !== null && asset.kind !== "image";

              let newDuration = (clip.duration * clip.speed) / newSpeed;

              const next = index < track.clips.length - 1 ? track.clips[index + 1] : null;
              if (next) {
                newDuration = Math.min(newDuration, Math.max(MIN_DURATION, next.start - clip.start));
              }
              if (isVideoAsset && asset) {
                // inPoint + duration*speed <= asset.duration(§4)を縮める方向にのみ先にクランプする。
                newDuration = Math.min(newDuration, (asset.duration - clip.inPoint) / newSpeed);
              }

              newDuration = Math.max(MIN_DURATION, newDuration);

              if (isVideoAsset && asset && clip.inPoint + newDuration * newSpeed > asset.duration + EPS) {
                // 最小長フロアがアセット境界と両立できない極端なケースは速度変更を諦める。
                return false;
              }

              merged.speed = newSpeed;
              merged.duration = newDuration;
            }

            track.clips[index] = merged;
            return true;
          }),

        detachAudio: (clipId) => {
          let newClipId: string | null = null;
          mutate((project) => {
            const loc = findClipLocation(project, clipId);
            if (!loc) return false;
            const { track: sourceTrack, clip } = loc;
            // 対象は hasAudio な video クリップのみ(テキスト/画像/音声クリップ/既にミュート済みは除く、§14.3)。
            if (sourceTrack.kind !== "video" || sourceTrack.locked || clip.assetId === null || clip.muted) {
              return false;
            }
            const asset = findAssetById(project, clip.assetId);
            if (!asset || asset.kind !== "video" || !asset.hasAudio) return false;

            // [start, start+duration] がまるごと空いている最初の(ロックされていない)audio トラックを探す。
            let targetTrack =
              project.audioTracks.find((t) => {
                if (t.locked) return false;
                return computeGaps(t.clips).some(
                  (g) => clip.start >= g.start - EPS && clip.start + clip.duration <= g.end + EPS,
                );
              }) ?? null;

            if (!targetTrack) {
              targetTrack = makeTrack("audio", `A${project.audioTracks.length + 1}`);
              project.audioTracks.push(targetTrack);
            }

            const newClip: Clip = {
              id: crypto.randomUUID(),
              assetId: clip.assetId,
              start: clip.start,
              duration: clip.duration,
              inPoint: clip.inPoint,
              speed: clip.speed,
              volume: clip.volume,
              muted: false,
              opacity: 1,
              transform: { x: 0, y: 0, scale: 1, rotation: 0 },
              fadeIn: clip.fadeIn,
              fadeOut: clip.fadeOut,
              effects: [],
              text: null,
              mosaics: [],
              transitionIn: null,
            };
            insertClipSorted(targetTrack.clips, newClip);
            clip.muted = true;
            newClipId = newClip.id;
            return true;
          });
          if (newClipId) log.info("ui", `音声切り離し: clipId=${clipId} newClipId=${newClipId}`);
          return newClipId;
        },

        importSrtCues: (cues) => {
          let result: { trackId: string; count: number } | null = null;
          mutate((project) => {
            if (cues.length === 0) return false;
            const track = makeTrack("video", `V${project.videoTracks.length + 1}`);
            // start 昇順で 1 件ずつ配置し、重なるキューは既存クリップとの空き区間へクランプする(§14.2)。
            const sorted = [...cues].sort((a, b) => a.start - b.start);
            for (const cue of sorted) {
              const duration = Math.max(MIN_DURATION, cue.end - cue.start);
              const start = clampToNonOverlapping(track.clips, Math.max(0, cue.start), duration);
              const clip: Clip = {
                id: crypto.randomUUID(),
                assetId: null,
                start,
                duration,
                inPoint: 0,
                speed: 1,
                volume: 1,
                muted: false,
                opacity: 1,
                // 既定スタイル(§14.2): transform.y = +settings.height*0.38。
                transform: { x: 0, y: project.settings.height * 0.38, scale: 1, rotation: 0 },
                fadeIn: 0,
                fadeOut: 0,
                effects: [],
                text: {
                  content: cue.text,
                  fontFamily: "Meiryo",
                  fontSize: 48,
                  color: "#FFFFFF",
                  bold: false,
                  align: "center",
                  background: null,
                  outlineColor: "#000000",
                  outlineWidth: 4,
                  shadowColor: null,
                  shadowX: 2,
                  shadowY: 2,
                  lineSpacing: 0,
                },
                mosaics: [],
                transitionIn: null,
              };
              insertClipSorted(track.clips, clip);
            }
            // 新規トラックは最上位(最後尾 = 最上層、§4)に追加する。
            project.videoTracks.push(track);
            result = { trackId: track.id, count: track.clips.length };
            return true;
          });
          return result;
        },

        addMosaicRegion: (clipId, time) => {
          let newId: string | null = null;
          mutate((project) => {
            const loc = findClipLocation(project, clipId);
            if (!loc) return false;
            const { clip } = loc;
            // 対象は video/image クリップのみ(§13.2)。
            if (clip.assetId === null) return false;
            const asset = findAssetById(project, clip.assetId);
            if (!asset || asset.kind === "audio") return false;

            // 既定領域: ソース中央、ソース幅/高さの 1/4(アセット解像度が不明ならプロジェクト解像度)。
            const w = asset.width ?? project.settings.width;
            const h = asset.height ?? project.settings.height;
            const id = crypto.randomUUID();
            const region: MosaicRegion = {
              id,
              enabled: true,
              blockSize: MOSAIC_BLOCK_SIZE_DEFAULT,
              keyframes: [
                {
                  time: Math.max(0, time),
                  cx: w / 2,
                  cy: h / 2,
                  w: w / 4,
                  h: h / 4,
                  rotation: 0,
                  visible: true,
                },
              ],
            };
            clip.mosaics.push(region);
            newId = id;
            return true;
          });
          if (newId) log.info("ui", `モザイク領域追加: clipId=${clipId} regionId=${newId} time=${time.toFixed(3)}`);
          return newId;
        },

        removeMosaicRegion: (clipId, regionId) =>
          mutate((project) => {
            const loc = findClipLocation(project, clipId);
            if (!loc) return false;
            const before = loc.clip.mosaics.length;
            loc.clip.mosaics = loc.clip.mosaics.filter((r) => r.id !== regionId);
            if (loc.clip.mosaics.length === before) return false;
            log.info("ui", `モザイク領域削除: clipId=${clipId} regionId=${regionId}`);
            return true;
          }),

        setMosaicRegionProps: (clipId, regionId, props) =>
          mutate((project) => {
            const loc = findClipLocation(project, clipId);
            if (!loc) return false;
            const region = loc.clip.mosaics.find((r) => r.id === regionId);
            if (!region) return false;
            let changed = false;
            if (props.enabled !== undefined && props.enabled !== region.enabled) {
              region.enabled = props.enabled;
              changed = true;
            }
            if (props.blockSize !== undefined) {
              const bs = Math.min(MOSAIC_BLOCK_SIZE_MAX, Math.max(MOSAIC_BLOCK_SIZE_MIN, Math.round(props.blockSize)));
              if (bs !== region.blockSize) {
                region.blockSize = bs;
                changed = true;
              }
            }
            if (changed) {
              log.info(
                "ui",
                `モザイク領域変更: clipId=${clipId} regionId=${regionId} enabled=${region.enabled} blockSize=${region.blockSize}`,
              );
            }
            return changed;
          }),

        upsertMosaicKeyframe: (clipId, regionId, kf) =>
          mutate((project) => {
            const loc = findClipLocation(project, clipId);
            if (!loc) return false;
            const region = loc.clip.mosaics.find((r) => r.id === regionId);
            if (!region) return false;
            const tolerance = sameTimeTolerance(project.settings.fps);
            region.keyframes = upsertKeyframe(region.keyframes, kf, tolerance);
            log.info(
              "ui",
              `モザイクキーフレーム記録: clipId=${clipId} regionId=${regionId} time=${kf.time.toFixed(3)} ` +
                `cx=${kf.cx.toFixed(1)} cy=${kf.cy.toFixed(1)} w=${kf.w.toFixed(1)} h=${kf.h.toFixed(1)} ` +
                `rot=${kf.rotation.toFixed(1)} visible=${kf.visible}`,
            );
            return true;
          }),

        removeMosaicKeyframe: (clipId, regionId, index) =>
          mutate((project) => {
            const loc = findClipLocation(project, clipId);
            if (!loc) return false;
            const region = loc.clip.mosaics.find((r) => r.id === regionId);
            if (!region) return false;
            if (index < 0 || index >= region.keyframes.length) return false;
            // キーフレームは常に 1 個以上を維持する(§13.2)。
            if (region.keyframes.length <= 1) return false;
            const removed = region.keyframes[index];
            region.keyframes = region.keyframes.filter((_, i) => i !== index);
            log.info(
              "ui",
              `モザイクキーフレーム削除: clipId=${clipId} regionId=${regionId} time=${removed.time.toFixed(3)}`,
            );
            return true;
          }),

        getClipById: (clipId) => {
          const loc = findClipLocation(get().project, clipId);
          return loc ? loc.clip : null;
        },
        getTrackOfClip: (clipId) => {
          const loc = findClipLocation(get().project, clipId);
          return loc ? loc.track : null;
        },
        getTimelineDuration: () => computeTimelineDuration(get().project),
      };
    },
    {
      limit: 100,
      partialize: (state) => ({ project: state.project }),
      handleSet: (handleSet) => {
        const debounced = debounce(handleSet, 300);
        debouncedHandleSetRef = debounced;
        return debounced;
      },
    },
  ),
);

/** タイムライン全長(秒)を購読する便宜フック。 */
export function useTimelineDuration(): number {
  return useProjectStore((s) => computeTimelineDuration(s.project));
}

// ---------------------------------------------------------------------------
// undo / redo(zundo)
// ---------------------------------------------------------------------------

export function undo(): void {
  const { pastStates } = useProjectStore.temporal.getState();
  if (pastStates.length === 0) return;
  useProjectStore.temporal.getState().undo();
  log.info("ui", "undo");
}

export function redo(): void {
  const { futureStates } = useProjectStore.temporal.getState();
  if (futureStates.length === 0) return;
  useProjectStore.temporal.getState().redo();
  log.info("ui", "redo");
}

export function clearHistory(): void {
  // 保留中のデバウンス済み push が後から発火して履歴を復活させるのを防ぐため、
  // clear() の前に必ずキャンセルする(newProject/loadProject 直後に呼ばれる想定)。
  debouncedHandleSetRef?.cancel();
  useProjectStore.temporal.getState().clear();
}

export function useCanUndo(): boolean {
  return useStore(useProjectStore.temporal, (s) => s.pastStates.length > 0);
}

export function useCanRedo(): boolean {
  return useStore(useProjectStore.temporal, (s) => s.futureStates.length > 0);
}
