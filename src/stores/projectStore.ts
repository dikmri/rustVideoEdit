// プロジェクト状態 + 操作アクション(DESIGN.md §4 データモデルのモデル操作ロジック一式)。
// P3 の Timeline UI 等はこのストアの関数を呼ぶだけにする(モデル操作ロジックはここに集約)。
import { create } from "zustand";
import { useStore } from "zustand";
import { temporal } from "zundo";

import type { Clip, MediaAsset, Project, ProjectSettings, Track } from "../types/model";
import { log } from "../lib/logger";
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
        loadProject: (project) => set({ project: structuredClone(project) }),

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
              },
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
            };
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
