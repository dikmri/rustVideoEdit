// プレビュー同期エンジン(DESIGN.md §7)。
// HTML5 レイヤー合成方式。projectStore/uiStore を購読し、video トラックごとに
// <video>/<img>/テキスト div レイヤー、audio トラックごとに <audio> を管理する。
// シングルトンとして export し、PreviewSurface が mount()/dispose() する。
import { convertFileSrc } from "@tauri-apps/api/core";

import { useProjectStore } from "../../stores/projectStore";
import { useUIStore } from "../../stores/uiStore";
import type { Clip, Effect, Project, Track, TransitionType } from "../../types/model";
import { sampleRegion } from "../mosaic";
import { log } from "../logger";

/** モザイクの実描画対象(領域 1 件分)。 */
interface ActiveMosaicRegion {
  blockSize: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
}

/** currentTime 補正の閾値(秒)。 */
const SYNC_THRESHOLD_SEC = 0.12;
/** 「隣接」とみなす許容誤差(秒、DESIGN §14.1: |A.end − B.start| < 0.001)。 */
const ADJACENT_EPS = 0.001;

interface VideoLayer {
  wrapper: HTMLDivElement;
  video: HTMLVideoElement;
  img: HTMLImageElement;
  /** モザイク描画用 canvas(§13.2)。<video>/<img> の直上に同サイズで重ねる。 */
  mosaicCanvas: HTMLCanvasElement;
  /** blockSize ごとの縮小用オフスクリーン canvas(使い回し)。 */
  mosaicScaled: Map<number, HTMLCanvasElement>;
  textDiv: HTMLDivElement;
  unsupportedDiv: HTMLDivElement;
  currentSrcPath: string | null;
  currentClipId: string | null;
}

/**
 * video トラック 1 本分のレイヤー対(DESIGN §14.1)。primary が通常表示(現在のアクティブクリップ B)、
 * outgoing はトランジション窓内でのみ直前クリップ A を表示する「送出用」サブレイヤー(z は primary の下)。
 */
interface TrackLayers {
  primary: VideoLayer;
  outgoing: VideoLayer;
}

/** 追加のオーバーレイ(トランジション用)。renderClipIntoLayer に渡す。 */
interface RenderExtras {
  extraOpacity: number;
  extraTranslateX: number;
  /** outgoing 表示用(§14.1)。書き出しでは A の音声は延長されない(extendTail は映像のみ)ため、
   * プレビューの outgoing でも音声を出さず挙動を一致させる。 */
  muteAudio: boolean;
}

const NO_EXTRAS: RenderExtras = { extraOpacity: 1, extraTranslateX: 0, muteAudio: false };

/**
 * wipe 系トランジションの clip-path(DESIGN §14.1)。p(0..1)は B 側の進行度。
 * wipeleft/up は表示領域が左/上から広がる(右/下を切る)、wiperight/down はその逆(左/上を切る)。
 */
function wipeClipPath(type: TransitionType, p: number): string {
  const cut = clamp01(1 - p) * 100;
  switch (type) {
    case "wipeleft":
      return `inset(0 ${cut}% 0 0)`;
    case "wiperight":
      return `inset(0 0 0 ${cut}%)`;
    case "wipeup":
      return `inset(0 0 ${cut}% 0)`;
    case "wipedown":
      return `inset(${cut}% 0 0 0)`;
    default:
      return "";
  }
}

interface AudioLayer {
  audio: HTMLAudioElement;
  currentSrcPath: string | null;
  currentClipId: string | null;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** フェードイン/アウトによる 0..1 の係数(線形)。 */
function fadeFactor(clip: Clip, localT: number): number {
  let factor = 1;
  if (clip.fadeIn > 0 && localT < clip.fadeIn) {
    factor *= clamp01(localT / clip.fadeIn);
  }
  const fadeOutStart = clip.duration - clip.fadeOut;
  if (clip.fadeOut > 0 && localT > fadeOutStart) {
    factor *= clamp01((clip.duration - localT) / clip.fadeOut);
  }
  return factor;
}

function findActiveClip(track: Track, playhead: number): Clip | null {
  return track.clips.find((c) => playhead >= c.start && playhead < c.start + c.duration) ?? null;
}

/** Effect[] を CSS filter 文字列に変換する(プレビュー用の近似)。 */
function cssFilterFor(effects: Effect[]): string {
  const parts: string[] = [];
  for (const eff of effects) {
    if (eff.type === "eq") {
      parts.push(`brightness(${1 + eff.brightness})`, `contrast(${eff.contrast})`, `saturate(${eff.saturation})`);
    } else if (eff.type === "blur" && eff.radius > 0) {
      parts.push(`blur(${eff.radius}px)`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : "none";
}

/**
 * extraTranslateX(既定 0)は slide トランジション(§14.1)用: B の translate(x,y) に
 * ±stageW*(1−p) を加算する。
 */
function transformStyle(clip: Clip, extraTranslateX = 0): string {
  const { x, y, scale, rotation } = clip.transform;
  return `translate(-50%, -50%) translate(${x + extraTranslateX}px, ${y}px) rotate(${rotation}deg) scale(${scale})`;
}

export class PlaybackEngine {
  private container: HTMLDivElement | null = null;
  private videoLayers = new Map<string, TrackLayers>();
  private audioLayers = new Map<string, AudioLayer>();
  private rafId: number | null = null;
  private baseTimeMs = 0;
  private basePlayhead = 0;
  private isInternalPlayheadUpdate = false;
  private unsubs: Array<() => void> = [];
  private unsupportedAssetIds = new Set<string>();
  private lastRenderedPlayhead = 0;

  /** ステージ(プロジェクト解像度と同じ px サイズの div)にレイヤーを構築して購読を開始する。 */
  mount(container: HTMLDivElement): void {
    this.container = container;
    this.syncLayers();
    this.renderFrame(useUIStore.getState().playhead);

    this.unsubs.push(
      useProjectStore.subscribe(() => {
        this.syncLayers();
        this.renderFrame(this.lastRenderedPlayhead);
      }),
    );
    this.unsubs.push(
      useUIStore.subscribe(
        (s) => s.playing,
        (playing) => this.onPlayingChange(playing),
      ),
    );
    this.unsubs.push(
      useUIStore.subscribe(
        (s) => s.playhead,
        (playhead) => this.onPlayheadChange(playhead),
      ),
    );
    // モザイク編集ドラッグ中の一時ドラフト(§13.2)。再生中は rAF の tick が毎フレーム
    // renderFrame を呼ぶため不要(むしろ二重描画になる)。一時停止中のみ、ドラフトの変化
    // (pointermove ごと)に合わせて現在フレームを再描画し、ドラッグ中も実プレビューさせる。
    this.unsubs.push(
      useUIStore.subscribe(
        (s) => s.mosaicDraft,
        () => {
          if (!useUIStore.getState().playing) this.renderFrame(this.lastRenderedPlayhead);
        },
      ),
    );

    // subscribe は以降の「変化」にのみ反応するため、mount 時点で既に再生中だった場合
    // (再マウント等)に備えて現在値にも明示的に追従させる。
    if (useUIStore.getState().playing) {
      this.onPlayingChange(true);
    }
  }

  /** 購読解除 + DOM 要素破棄。 */
  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.pauseAllMedia();
    for (const layers of this.videoLayers.values()) {
      layers.primary.wrapper.remove();
      layers.outgoing.wrapper.remove();
    }
    for (const layer of this.audioLayers.values()) layer.audio.remove();
    this.videoLayers.clear();
    this.audioLayers.clear();
    this.container = null;
  }

  private onPlayingChange(playing: boolean): void {
    if (playing) {
      this.basePlayhead = useUIStore.getState().playhead;
      this.baseTimeMs = performance.now();
      if (this.rafId === null) this.rafId = requestAnimationFrame(this.tick);
    } else {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.pauseAllMedia();
    }
  }

  private onPlayheadChange(playhead: number): void {
    if (this.isInternalPlayheadUpdate) return; // 自分自身の rAF 更新は無視
    if (useUIStore.getState().playing) {
      // 再生中の外部シーク: 基準点を更新して以降も滑らかに再生を続ける。
      this.basePlayhead = playhead;
      this.baseTimeMs = performance.now();
    }
    this.renderFrame(playhead);
  }

  private tick = (): void => {
    const elapsedSec = (performance.now() - this.baseTimeMs) / 1000;
    let playhead = this.basePlayhead + elapsedSec;
    const duration = useProjectStore.getState().getTimelineDuration();

    if (duration > 0 && playhead >= duration) {
      playhead = duration;
      this.renderFrame(playhead);
      this.writePlayhead(playhead);
      useUIStore.getState().setPlaying(false); // 末尾到達で自動停止
      return;
    }

    this.renderFrame(playhead);
    this.writePlayhead(playhead);
    this.rafId = requestAnimationFrame(this.tick);
  };

  private writePlayhead(playhead: number): void {
    this.isInternalPlayheadUpdate = true;
    useUIStore.getState().setPlayhead(playhead);
    this.isInternalPlayheadUpdate = false;
  }

  private pauseAllMedia(): void {
    for (const layers of this.videoLayers.values()) {
      layers.primary.video.pause();
      layers.outgoing.video.pause();
    }
    for (const layer of this.audioLayers.values()) layer.audio.pause();
  }

  /** トラック構成の変化(追加/削除)に合わせて DOM レイヤーを再構築する。 */
  private syncLayers(): void {
    if (!this.container) return;
    const project = useProjectStore.getState().project;

    const videoTrackIds = new Set(project.videoTracks.map((t) => t.id));
    for (const [trackId, layers] of this.videoLayers) {
      if (!videoTrackIds.has(trackId)) {
        layers.primary.wrapper.remove();
        layers.outgoing.wrapper.remove();
        this.videoLayers.delete(trackId);
      }
    }
    project.videoTracks.forEach((track, index) => {
      let layers = this.videoLayers.get(track.id);
      if (!layers) {
        layers = { primary: this.createVideoLayer(), outgoing: this.createVideoLayer() };
        this.videoLayers.set(track.id, layers);
        // outgoing を先に追加(DOM 順・z-index とも primary の下にするため)。
        this.container?.appendChild(layers.outgoing.wrapper);
        this.container?.appendChild(layers.primary.wrapper);
      }
      // index 0 = V1 = 最下層(DESIGN §4)。各トラックにつき outgoing/primary の 2 枚を使うため
      // z-index は index*2(outgoing)/index*2+1(primary)で採番し、トラック間の順序を保つ。
      layers.outgoing.wrapper.style.zIndex = String(index * 2);
      layers.primary.wrapper.style.zIndex = String(index * 2 + 1);
    });

    const audioTrackIds = new Set(project.audioTracks.map((t) => t.id));
    for (const [trackId, layer] of this.audioLayers) {
      if (!audioTrackIds.has(trackId)) {
        layer.audio.remove();
        this.audioLayers.delete(trackId);
      }
    }
    for (const track of project.audioTracks) {
      if (!this.audioLayers.has(track.id)) {
        const layer = this.createAudioLayer();
        this.audioLayers.set(track.id, layer);
        this.container?.appendChild(layer.audio);
      }
    }
  }

  private createVideoLayer(): VideoLayer {
    const wrapper = document.createElement("div");
    wrapper.style.position = "absolute";
    wrapper.style.left = "50%";
    wrapper.style.top = "50%";
    wrapper.style.transformOrigin = "center center";
    wrapper.style.display = "none";

    const video = document.createElement("video");
    video.style.display = "block";
    video.addEventListener("error", () => {
      const assetId = video.dataset.assetId;
      if (assetId) {
        this.unsupportedAssetIds.add(assetId);
        log.error("preview", `プレビュー非対応のコーデックです: assetId=${assetId}`);
        this.renderFrame(this.lastRenderedPlayhead);
      }
    });

    const img = document.createElement("img");
    img.style.display = "none";

    // モザイク canvas(§13.2)。wrapper 内で <video>/<img> の直上に同サイズで重ねるため、
    // CSS transform(scale/rotate)や opacity/filter は wrapper 経由で自動的に共通適用される。
    const mosaicCanvas = document.createElement("canvas");
    mosaicCanvas.style.position = "absolute";
    mosaicCanvas.style.left = "0";
    mosaicCanvas.style.top = "0";
    mosaicCanvas.style.pointerEvents = "none";
    mosaicCanvas.style.display = "none";

    const textDiv = document.createElement("div");
    textDiv.style.display = "none";
    textDiv.style.whiteSpace = "pre-wrap";

    const unsupportedDiv = document.createElement("div");
    unsupportedDiv.style.display = "none";
    unsupportedDiv.style.color = "#fff";
    unsupportedDiv.style.background = "rgba(0,0,0,0.6)";
    unsupportedDiv.style.padding = "8px 12px";
    unsupportedDiv.style.fontSize = "13px";
    unsupportedDiv.style.whiteSpace = "nowrap";
    unsupportedDiv.textContent = "プレビュー非対応";

    wrapper.appendChild(video);
    wrapper.appendChild(img);
    wrapper.appendChild(mosaicCanvas);
    wrapper.appendChild(textDiv);
    wrapper.appendChild(unsupportedDiv);

    const layer: VideoLayer = {
      wrapper,
      video,
      img,
      mosaicCanvas,
      mosaicScaled: new Map(),
      textDiv,
      unsupportedDiv,
      currentSrcPath: null,
      currentClipId: null,
    };

    // 一時停止中のシーク: currentTime 補正の完了(seeked)後にフレーム内容が変わるため、
    // その時点のフレームでモザイクを描き直す(古いフレームのモザイクが残る/消える不整合の防止)。
    video.addEventListener("seeked", () => {
      if (!useUIStore.getState().playing) this.redrawMosaicForLayer(layer);
    });
    // src 差し替え直後(currentTime 補正が閾値未満で seeked が来ないケース)にも描けるよう
    // 最初のフレームが利用可能になった時点でも描き直す。
    video.addEventListener("loadeddata", () => {
      if (!useUIStore.getState().playing) this.redrawMosaicForLayer(layer);
    });
    // 画像の読込完了時も同様に描き直す(読込前は drawImage できないため)。
    img.addEventListener("load", () => {
      this.redrawMosaicForLayer(layer);
    });

    return layer;
  }

  private createAudioLayer(): AudioLayer {
    const audio = document.createElement("audio");
    audio.style.display = "none";
    return { audio, currentSrcPath: null, currentClipId: null };
  }

  /** 指定した playhead(秒)の内容を各レイヤーへ反映する。 */
  renderFrame(playhead: number): void {
    this.lastRenderedPlayhead = playhead;
    const project = useProjectStore.getState().project;
    const playing = useUIStore.getState().playing;

    project.videoTracks.forEach((track) => {
      const layers = this.videoLayers.get(track.id);
      if (layers) this.renderVideoTrack(project, track, layers, playhead, playing);
    });

    project.audioTracks.forEach((track) => {
      const layer = this.audioLayers.get(track.id);
      if (layer) this.renderAudioTrack(project, track, layer, playhead, playing);
    });
  }

  /**
   * video トラック 1 本分を描画する(DESIGN §14.1)。primary には現在のアクティブクリップ B を、
   * B がトランジション窓内かつ直前の隣接クリップ A が存在する場合は outgoing に A を表示する
   * (窓外では outgoing を隠す)。B 自身にはトランジション種別に応じた opacity 乗算/clip-path/
   * translate 加算を適用する。
   */
  private renderVideoTrack(
    project: Project,
    track: Track,
    layers: TrackLayers,
    playhead: number,
    playing: boolean,
  ): void {
    const clip = findActiveClip(track, playhead);
    if (!clip) {
      this.hideClipLayer(layers.primary);
      this.hideClipLayer(layers.outgoing);
      return;
    }

    const localT = playhead - clip.start;
    const transition = clip.transitionIn;
    const transitionDuration = transition ? Math.max(1e-3, transition.duration) : 0;
    // localT はクリップ先頭からの経過秒(findActiveClip により常に >= 0)。
    const inTransitionWindow = transition !== null && localT < transitionDuration;
    const progress = inTransitionWindow ? clamp01(localT / transitionDuration) : 1;

    const extras: RenderExtras = { ...NO_EXTRAS };
    if (inTransitionWindow && transition) {
      if (transition.type === "dissolve") {
        extras.extraOpacity = progress;
      } else if (transition.type === "slideleft") {
        extras.extraTranslateX = project.settings.width * (1 - progress);
      } else if (transition.type === "slideright") {
        extras.extraTranslateX = -project.settings.width * (1 - progress);
      }
    }

    this.renderClipIntoLayer(layers.primary, project, track, clip, localT, playing, extras);
    layers.primary.wrapper.style.clipPath =
      inTransitionWindow && transition ? wipeClipPath(transition.type, progress) : "";

    // 直前の隣接クリップ A(DESIGN §14.1: |A.end - B.start| < 0.001)を outgoing に表示する。
    let outgoingClip: Clip | null = null;
    if (inTransitionWindow) {
      const idx = track.clips.findIndex((c) => c.id === clip.id);
      const prev = idx > 0 ? track.clips[idx - 1] : null;
      if (prev && Math.abs(prev.start + prev.duration - clip.start) < ADJACENT_EPS) {
        outgoingClip = prev;
      }
    }

    if (outgoingClip) {
      const outgoingLocalT = playhead - outgoingClip.start;
      this.renderClipIntoLayer(layers.outgoing, project, track, outgoingClip, outgoingLocalT, playing, {
        ...NO_EXTRAS,
        muteAudio: true,
      });
      layers.outgoing.wrapper.style.clipPath = "";
    } else {
      this.hideClipLayer(layers.outgoing);
    }
  }

  /** レイヤーを非表示にしてメディアを一時停止し、モザイクをクリアする(クリップ不在時・窓外の outgoing 用)。 */
  private hideClipLayer(layer: VideoLayer): void {
    layer.wrapper.style.display = "none";
    layer.wrapper.style.clipPath = "";
    layer.video.pause();
    layer.currentClipId = null;
    this.hideMosaic(layer);
  }

  /**
   * 1 クリップ分の内容を指定レイヤーへ描画する(primary/outgoing 共通)。
   * extras(既定は無効化)でトランジション用の opacity 乗算/translate 加算を適用できる。
   */
  private renderClipIntoLayer(
    layer: VideoLayer,
    project: Project,
    track: Track,
    clip: Clip,
    localT: number,
    playing: boolean,
    extras: RenderExtras = NO_EXTRAS,
  ): void {
    layer.wrapper.style.display = "block";
    const fade = fadeFactor(clip, localT);
    layer.wrapper.style.opacity = String(clamp01(clip.opacity) * fade * extras.extraOpacity);
    layer.wrapper.style.transform = transformStyle(clip, extras.extraTranslateX);
    layer.wrapper.style.filter = cssFilterFor(clip.effects);

    if (clip.text) {
      layer.video.style.display = "none";
      layer.img.style.display = "none";
      layer.unsupportedDiv.style.display = "none";
      layer.video.pause();
      this.hideMosaic(layer);
      this.renderTextClip(layer, clip);
      layer.currentClipId = clip.id;
      return;
    }

    const asset = clip.assetId ? (project.assets.find((a) => a.id === clip.assetId) ?? null) : null;
    if (!asset) {
      layer.wrapper.style.display = "none";
      this.hideMosaic(layer);
      return;
    }

    if (asset.kind === "video" && this.unsupportedAssetIds.has(asset.id)) {
      layer.video.style.display = "none";
      layer.img.style.display = "none";
      layer.textDiv.style.display = "none";
      layer.unsupportedDiv.style.display = "block";
      layer.video.pause();
      this.hideMosaic(layer);
      layer.currentClipId = clip.id;
      return;
    }

    layer.unsupportedDiv.style.display = "none";
    layer.textDiv.style.display = "none";

    const w = asset.width ?? project.settings.width;
    const h = asset.height ?? project.settings.height;

    if (asset.kind === "image") {
      layer.video.style.display = "none";
      layer.video.pause();
      layer.img.style.display = "block";
      layer.img.style.width = `${w}px`;
      layer.img.style.height = `${h}px`;
      const path = convertFileSrc(asset.path);
      if (layer.currentSrcPath !== path) {
        layer.img.src = path;
        layer.currentSrcPath = path;
      }
      layer.currentClipId = clip.id;
      this.renderMosaic(layer, clip, layer.img, w, h, localT);
      return;
    }

    // video アセット(音声はこの <video> 要素経由で再生される)。
    layer.img.style.display = "none";
    layer.video.style.display = "block";
    layer.video.style.width = `${w}px`;
    layer.video.style.height = `${h}px`;
    layer.video.dataset.assetId = asset.id;

    const path = convertFileSrc(asset.path);
    if (layer.currentSrcPath !== path) {
      layer.video.src = path;
      layer.currentSrcPath = path;
    }

    layer.video.playbackRate = clip.speed;
    // outgoing 表示(§14.1)では localT がクリップ自身の duration を超えることがある。
    // その場合 currentTime はソース末尾以上を指すため、ブラウザが最終フレームで止める挙動に任せる。
    const expected = clip.inPoint + localT * clip.speed;
    if (Math.abs(layer.video.currentTime - expected) > SYNC_THRESHOLD_SEC) {
      layer.video.currentTime = expected;
    }

    const muted = clip.muted || track.muted || extras.muteAudio;
    layer.video.muted = muted;
    layer.video.volume = muted ? 0 : clamp01(clip.volume * fade);

    if (playing) {
      if (layer.video.paused) void layer.video.play().catch(() => {});
    } else {
      layer.video.pause();
    }

    layer.currentClipId = clip.id;
    this.renderMosaic(layer, clip, layer.video, w, h, localT);
  }

  /** モザイク canvas をクリアして非表示にする。 */
  private hideMosaic(layer: VideoLayer): void {
    if (layer.mosaicCanvas.style.display === "none") return;
    const ctx = layer.mosaicCanvas.getContext("2d");
    ctx?.clearRect(0, 0, layer.mosaicCanvas.width, layer.mosaicCanvas.height);
    layer.mosaicCanvas.style.display = "none";
  }

  /**
   * 描画対象クリップの実効モザイク領域一覧を返す(DESIGN §13.2)。
   * mosaicDraft(§13.2、MosaicEditOverlay がドラッグ中に書き込む一時ドラフト)が
   * この clip を指している場合、確定前の値をここで上書き/追加する:
   * - regionId が既存 region と一致 → その region の sample・blockSize をドラフトで上書き
   *   (visible もドラフト値。enabled による除外は既存領域と同様に適用する)
   * - regionId が null → 新規作成ドラッグ中のドラフト矩形を追加領域として描画する
   */
  private computeActiveMosaicRegions(clip: Clip, localT: number): ActiveMosaicRegion[] {
    const draft = useUIStore.getState().mosaicDraft;
    const draftForClip = draft && draft.clipId === clip.id ? draft : null;

    const active: ActiveMosaicRegion[] = [];
    for (const region of clip.mosaics) {
      if (!region.enabled) continue;
      const isOverridden = draftForClip !== null && draftForClip.regionId === region.id;
      const s = isOverridden ? draftForClip!.sample : sampleRegion(region, localT);
      const blockSize = isOverridden ? draftForClip!.blockSize : region.blockSize;
      if (!s || !s.visible || s.w <= 0 || s.h <= 0) continue;
      active.push({ blockSize, cx: s.cx, cy: s.cy, w: s.w, h: s.h, rotation: s.rotation });
    }
    if (draftForClip && draftForClip.regionId === null) {
      const s = draftForClip.sample;
      if (s.visible && s.w > 0 && s.h > 0) {
        active.push({ blockSize: draftForClip.blockSize, cx: s.cx, cy: s.cy, w: s.w, h: s.h, rotation: s.rotation });
      }
    }
    return active;
  }

  /**
   * モザイク領域を canvas に描画する(DESIGN §13.2 のプレビュー方式)。
   * (1) blockSize ごとにフレーム全体を 1/blockSize でオフスクリーンへ縮小描画し、
   * (2) メイン canvas で回転矩形パスに clip して imageSmoothingEnabled=false で拡大描画する。
   */
  private renderMosaic(
    layer: VideoLayer,
    clip: Clip,
    source: HTMLVideoElement | HTMLImageElement,
    w: number,
    h: number,
    localT: number,
  ): void {
    const active = this.computeActiveMosaicRegions(clip, localT);
    if (active.length === 0) {
      this.hideMosaic(layer);
      return;
    }

    // ソースフレームが未準備なら前回の内容を残さないようクリアだけして待つ
    // (video: seeked / img: load 後に redrawMosaicForLayer で再描画される)。
    const ready =
      source instanceof HTMLVideoElement
        ? source.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        : source.complete && source.naturalWidth > 0;
    const canvas = layer.mosaicCanvas;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    canvas.style.display = "block";
    if (!ready) return;

    // (1) blockSize ごとの縮小フレーム(同一 blockSize の領域間で共有)。
    const scaledFrames = new Map<number, HTMLCanvasElement>();
    for (const a of active) {
      if (scaledFrames.has(a.blockSize)) continue;
      const sw = Math.max(1, Math.ceil(w / a.blockSize));
      const sh = Math.max(1, Math.ceil(h / a.blockSize));
      let off = layer.mosaicScaled.get(a.blockSize);
      if (!off) {
        off = document.createElement("canvas");
        layer.mosaicScaled.set(a.blockSize, off);
      }
      if (off.width !== sw || off.height !== sh) {
        off.width = sw;
        off.height = sh;
      }
      const octx = off.getContext("2d");
      if (!octx) continue;
      octx.clearRect(0, 0, sw, sh);
      octx.drawImage(source, 0, 0, sw, sh);
      scaledFrames.set(a.blockSize, off);
    }

    // (2) 回転矩形パスに clip して拡大描画。
    for (const a of active) {
      const off = scaledFrames.get(a.blockSize);
      if (!off) continue;
      ctx.save();
      ctx.translate(a.cx, a.cy);
      ctx.rotate((a.rotation * Math.PI) / 180);
      ctx.beginPath();
      ctx.rect(-a.w / 2, -a.h / 2, a.w, a.h);
      ctx.clip();
      // clip パス設定後は元のフレーム座標系に戻して全体を拡大描画する
      // (モザイクのブロック格子はソースに対して固定のままにする)。
      ctx.rotate((-a.rotation * Math.PI) / 180);
      ctx.translate(-a.cx, -a.cy);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, off.width, off.height, 0, 0, w, h);
      ctx.restore();
    }
  }

  /** seeked / load 後にモザイクを現在フレームで描き直す(一時停止中のシーク対応)。 */
  private redrawMosaicForLayer(layer: VideoLayer): void {
    if (!layer.currentClipId) return;
    const project = useProjectStore.getState().project;
    for (const track of project.videoTracks) {
      const clip = track.clips.find((c) => c.id === layer.currentClipId);
      if (!clip) continue;
      if (clip.text || clip.assetId === null) return;
      const asset = project.assets.find((a) => a.id === clip.assetId) ?? null;
      if (!asset || asset.kind === "audio") return;
      const w = asset.width ?? project.settings.width;
      const h = asset.height ?? project.settings.height;
      const source = asset.kind === "image" ? layer.img : layer.video;
      const localT = this.lastRenderedPlayhead - clip.start;
      this.renderMosaic(layer, clip, source, w, h, localT);
      return;
    }
  }

  private renderTextClip(layer: VideoLayer, clip: Clip): void {
    const text = clip.text;
    if (!text) return;
    layer.textDiv.style.display = "inline-block";
    layer.textDiv.textContent = text.content;
    layer.textDiv.style.fontFamily = text.fontFamily;
    layer.textDiv.style.fontSize = `${text.fontSize}px`;
    layer.textDiv.style.color = text.color;
    layer.textDiv.style.fontWeight = text.bold ? "700" : "400";
    layer.textDiv.style.textAlign = text.align;
    layer.textDiv.style.background = text.background ? `${text.background}99` : "transparent";
    layer.textDiv.style.padding = text.background ? "4px 8px" : "0";
    // テキスト強化(DESIGN §14.2): 縁取り/影/行間の CSS 近似。
    layer.textDiv.style.webkitTextStroke =
      text.outlineColor && text.outlineWidth > 0 ? `${text.outlineWidth}px ${text.outlineColor}` : "";
    layer.textDiv.style.textShadow = text.shadowColor ? `${text.shadowX}px ${text.shadowY}px 0 ${text.shadowColor}` : "";
    layer.textDiv.style.lineHeight = text.lineSpacing > 0 ? `${text.fontSize + text.lineSpacing}px` : "normal";
  }

  private renderAudioTrack(
    project: Project,
    track: Track,
    layer: AudioLayer,
    playhead: number,
    playing: boolean,
  ): void {
    const clip = findActiveClip(track, playhead);
    if (!clip || !clip.assetId) {
      layer.audio.pause();
      layer.currentClipId = null;
      return;
    }
    const asset = project.assets.find((a) => a.id === clip.assetId) ?? null;
    if (!asset) {
      layer.audio.pause();
      return;
    }

    const path = convertFileSrc(asset.path);
    if (layer.currentSrcPath !== path) {
      layer.audio.src = path;
      layer.currentSrcPath = path;
    }

    const localT = playhead - clip.start;
    const fade = fadeFactor(clip, localT);
    layer.audio.playbackRate = clip.speed;
    const expected = clip.inPoint + localT * clip.speed;
    if (Math.abs(layer.audio.currentTime - expected) > SYNC_THRESHOLD_SEC) {
      layer.audio.currentTime = expected;
    }

    const muted = clip.muted || track.muted;
    layer.audio.muted = muted;
    layer.audio.volume = muted ? 0 : clamp01(clip.volume * fade);

    if (playing) {
      if (layer.audio.paused) void layer.audio.play().catch(() => {});
    } else {
      layer.audio.pause();
    }

    layer.currentClipId = clip.id;
  }
}

/** アプリ内に 1 つだけ存在するプレビューエンジン(PreviewSurface が mount/dispose する)。 */
export const playbackEngine = new PlaybackEngine();
