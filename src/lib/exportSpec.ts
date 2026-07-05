// Project → ExportSpec 変換(DESIGN.md §5, §8)。
import type {
  AClip,
  Clip,
  ExportInput,
  ExportSpec,
  MediaAsset,
  Project,
  Track,
  VClip,
  VideoCodec,
} from "../types/model";

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  videoCodec: VideoCodec;
  quality: number;
  audioBitrateKbps: number;
}

function sortedClips(track: Track): Clip[] {
  return [...track.clips].sort((a, b) => a.start - b.start);
}

function assetOf(project: Project, assetId: string | null): MediaAsset | null {
  if (assetId === null) return null;
  return project.assets.find((a) => a.id === assetId) ?? null;
}

/**
 * 全クリップの参照順(videoTracks を index 0(V1)から順に、各トラック内 start 昇順 →
 * audioTracks も同様)でユニークな assetId を集め、初出順に ffmpeg -i の index を採番する
 * (DESIGN §5 inputs)。テキストのみのクリップ(assetId=null)は寄与しない。
 */
function buildInputs(project: Project): { inputs: ExportInput[]; indexOf: Map<string, number> } {
  const indexOf = new Map<string, number>();
  const inputs: ExportInput[] = [];

  function visit(assetId: string | null): void {
    if (assetId === null || indexOf.has(assetId)) return;
    const asset = assetOf(project, assetId);
    if (!asset) return;
    const index = inputs.length;
    indexOf.set(assetId, index);
    inputs.push({ index, path: asset.path, kind: asset.kind });
  }

  for (const track of project.videoTracks) {
    for (const clip of sortedClips(track)) visit(clip.assetId);
  }
  for (const track of project.audioTracks) {
    for (const clip of sortedClips(track)) visit(clip.assetId);
  }

  return { inputs, indexOf };
}

/** videoTracks を index 0(V1、最下層)から順に処理する(DESIGN §8: 下層→上層の順に overlay を連鎖)。
 * UI の表示順(video を逆順表示)とは無関係なので混同しないこと。 */
function buildVideoClips(project: Project, indexOf: Map<string, number>): VClip[] {
  const result: VClip[] = [];
  for (const track of project.videoTracks) {
    for (const clip of sortedClips(track)) {
      const asset = assetOf(project, clip.assetId);
      result.push({
        inputIndex: clip.assetId !== null ? (indexOf.get(clip.assetId) ?? null) : null,
        start: clip.start,
        duration: clip.duration,
        inPoint: clip.inPoint,
        speed: clip.speed,
        opacity: clip.opacity,
        transform: { ...clip.transform },
        fadeIn: clip.fadeIn,
        fadeOut: clip.fadeOut,
        effects: clip.effects.map((e) => ({ ...e })),
        text: clip.text ? { ...clip.text } : null,
        assetW: asset?.width ?? null,
        assetH: asset?.height ?? null,
        isImage: asset?.kind === "image",
      });
    }
  }
  return result;
}

function clipToAClip(clip: Clip, indexOf: Map<string, number>): AClip | null {
  if (clip.assetId === null) return null;
  const inputIndex = indexOf.get(clip.assetId);
  if (inputIndex === undefined) return null;
  return {
    inputIndex,
    start: clip.start,
    duration: clip.duration,
    inPoint: clip.inPoint,
    speed: clip.speed,
    volume: clip.volume,
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
  };
}

/** audioTracks のクリップ + 音声付き video アセットのクリップ(トラック muted / クリップ muted を
 * それぞれ除外)を集める(DESIGN §5, §8)。volume はクリップ値をそのまま使う。 */
function buildAudioClips(project: Project, indexOf: Map<string, number>): AClip[] {
  const result: AClip[] = [];

  for (const track of project.audioTracks) {
    if (track.muted) continue;
    for (const clip of sortedClips(track)) {
      if (clip.muted) continue;
      const aclip = clipToAClip(clip, indexOf);
      if (aclip) result.push(aclip);
    }
  }

  for (const track of project.videoTracks) {
    if (track.muted) continue;
    for (const clip of sortedClips(track)) {
      if (clip.muted) continue;
      const asset = assetOf(project, clip.assetId);
      if (!asset || !asset.hasAudio) continue;
      const aclip = clipToAClip(clip, indexOf);
      if (aclip) result.push(aclip);
    }
  }

  return result;
}

/** タイムライン全長 = 全クリップ(video/audio 両トラック)の max(start+duration)。 */
function computeDurationSec(project: Project): number {
  let max = 0;
  for (const track of [...project.videoTracks, ...project.audioTracks]) {
    for (const clip of track.clips) {
      max = Math.max(max, clip.start + clip.duration);
    }
  }
  return max;
}

export function buildExportSpec(project: Project, outputPath: string, options: ExportOptions): ExportSpec {
  const { inputs, indexOf } = buildInputs(project);
  return {
    outputPath,
    width: options.width,
    height: options.height,
    fps: options.fps,
    sampleRate: project.settings.sampleRate,
    durationSec: computeDurationSec(project),
    videoCodec: options.videoCodec,
    quality: options.quality,
    audioBitrateKbps: options.audioBitrateKbps,
    inputs,
    videoClips: buildVideoClips(project, indexOf),
    audioClips: buildAudioClips(project, indexOf),
  };
}
