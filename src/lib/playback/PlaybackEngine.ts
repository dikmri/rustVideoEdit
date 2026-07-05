// プレビュー同期エンジン(DESIGN.md §7)。
// HTML5 レイヤー合成方式。projectStore/uiStore を購読し、video トラックごとに
// <video>/<img>/テキスト div レイヤー、audio トラックごとに <audio> を管理する。
// シングルトンとして export し、PreviewSurface が mount()/dispose() する。
import { convertFileSrc } from "@tauri-apps/api/core";

import { useProjectStore } from "../../stores/projectStore";
import { useUIStore } from "../../stores/uiStore";
import type { Clip, Effect, Project, Track } from "../../types/model";
import { log } from "../logger";

/** currentTime 補正の閾値(秒)。 */
const SYNC_THRESHOLD_SEC = 0.12;

interface VideoLayer {
  wrapper: HTMLDivElement;
  video: HTMLVideoElement;
  img: HTMLImageElement;
  textDiv: HTMLDivElement;
  unsupportedDiv: HTMLDivElement;
  currentSrcPath: string | null;
  currentClipId: string | null;
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

function transformStyle(clip: Clip): string {
  const { x, y, scale, rotation } = clip.transform;
  return `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${rotation}deg) scale(${scale})`;
}

export class PlaybackEngine {
  private container: HTMLDivElement | null = null;
  private videoLayers = new Map<string, VideoLayer>();
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
    for (const layer of this.videoLayers.values()) layer.wrapper.remove();
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
    for (const layer of this.videoLayers.values()) layer.video.pause();
    for (const layer of this.audioLayers.values()) layer.audio.pause();
  }

  /** トラック構成の変化(追加/削除)に合わせて DOM レイヤーを再構築する。 */
  private syncLayers(): void {
    if (!this.container) return;
    const project = useProjectStore.getState().project;

    const videoTrackIds = new Set(project.videoTracks.map((t) => t.id));
    for (const [trackId, layer] of this.videoLayers) {
      if (!videoTrackIds.has(trackId)) {
        layer.wrapper.remove();
        this.videoLayers.delete(trackId);
      }
    }
    project.videoTracks.forEach((track, index) => {
      let layer = this.videoLayers.get(track.id);
      if (!layer) {
        layer = this.createVideoLayer();
        this.videoLayers.set(track.id, layer);
        this.container?.appendChild(layer.wrapper);
      }
      // index 0 = V1 = 最下層(DESIGN §4)。
      layer.wrapper.style.zIndex = String(index);
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
    wrapper.appendChild(textDiv);
    wrapper.appendChild(unsupportedDiv);

    return { wrapper, video, img, textDiv, unsupportedDiv, currentSrcPath: null, currentClipId: null };
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
      const layer = this.videoLayers.get(track.id);
      if (layer) this.renderVideoTrack(project, track, layer, playhead, playing);
    });

    project.audioTracks.forEach((track) => {
      const layer = this.audioLayers.get(track.id);
      if (layer) this.renderAudioTrack(project, track, layer, playhead, playing);
    });
  }

  private renderVideoTrack(
    project: Project,
    track: Track,
    layer: VideoLayer,
    playhead: number,
    playing: boolean,
  ): void {
    const clip = findActiveClip(track, playhead);
    if (!clip) {
      layer.wrapper.style.display = "none";
      layer.video.pause();
      layer.currentClipId = null;
      return;
    }

    layer.wrapper.style.display = "block";
    const localT = playhead - clip.start;
    const fade = fadeFactor(clip, localT);
    layer.wrapper.style.opacity = String(clamp01(clip.opacity) * fade);
    layer.wrapper.style.transform = transformStyle(clip);
    layer.wrapper.style.filter = cssFilterFor(clip.effects);

    if (clip.text) {
      layer.video.style.display = "none";
      layer.img.style.display = "none";
      layer.unsupportedDiv.style.display = "none";
      layer.video.pause();
      this.renderTextClip(layer, clip);
      layer.currentClipId = clip.id;
      return;
    }

    const asset = clip.assetId ? (project.assets.find((a) => a.id === clip.assetId) ?? null) : null;
    if (!asset) {
      layer.wrapper.style.display = "none";
      return;
    }

    if (asset.kind === "video" && this.unsupportedAssetIds.has(asset.id)) {
      layer.video.style.display = "none";
      layer.img.style.display = "none";
      layer.textDiv.style.display = "none";
      layer.unsupportedDiv.style.display = "block";
      layer.video.pause();
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
    const expected = clip.inPoint + localT * clip.speed;
    if (Math.abs(layer.video.currentTime - expected) > SYNC_THRESHOLD_SEC) {
      layer.video.currentTime = expected;
    }

    const muted = clip.muted || track.muted;
    layer.video.muted = muted;
    layer.video.volume = muted ? 0 : clamp01(clip.volume * fade);

    if (playing) {
      if (layer.video.paused) void layer.video.play().catch(() => {});
    } else {
      layer.video.pause();
    }

    layer.currentClipId = clip.id;
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
