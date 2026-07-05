// タイムライン座標計算・スナップ・目盛間隔選択の共通ヘルパー(DESIGN.md §9)。
// Ruler/TrackLane/ClipView/Timeline で重複させないためここに集約する。
import type { Project, Track } from "../../types/model";

/** 左側 TrackHeader 列の固定幅(px)。 */
export const TRACK_HEADER_WIDTH = 140;
/** ルーラーの高さ(px)。 */
export const RULER_HEIGHT = 28;
/** 行高(DESIGN §9): video 64px / audio 48px。 */
export const ROW_HEIGHT_VIDEO = 64;
export const ROW_HEIGHT_AUDIO = 48;
/** コンテンツ幅はタイムライン全長 + この秒数以上を確保する(DESIGN §9)。 */
export const CONTENT_EXTRA_SEC = 30;
/** スナップ閾値(px)。実際の秒数換算は SNAP_THRESHOLD_PX / pxPerSecond。 */
export const SNAP_THRESHOLD_PX = 8;
/** クリップ端のトリムハンドル幅(px)。 */
export const TRIM_HANDLE_PX = 6;
/** クリック/ドラッグを区別する移動量の閾値(px)。 */
export const DRAG_THRESHOLD_PX = 5;

const TICK_INTERVALS = [1, 2, 5, 10, 30, 60];
const MIN_TICK_PX = 56;

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function secToPx(sec: number, pxPerSecond: number): number {
  return sec * pxPerSecond;
}

export function pxToSec(px: number, pxPerSecond: number): number {
  return px / pxPerSecond;
}

/** ズームに応じた目盛間隔(秒)を 1/2/5/10/30/60 から選択する(DESIGN §9)。 */
export function chooseTickInterval(pxPerSecond: number): number {
  for (const interval of TICK_INTERVALS) {
    if (interval * pxPerSecond >= MIN_TICK_PX) return interval;
  }
  return TICK_INTERVALS[TICK_INTERVALS.length - 1];
}

/** 表示順トラック一覧: video を逆順(上ほど上層)→ audio を順に(DESIGN §4, §9)。 */
export function orderedTracks(project: Project): Track[] {
  return [...project.videoTracks].reverse().concat(project.audioTracks);
}

export function rowHeightOf(kind: "video" | "audio"): number {
  return kind === "video" ? ROW_HEIGHT_VIDEO : ROW_HEIGHT_AUDIO;
}

/** 全トラックのクリップ端点(start, start+duration)を集める(指定 clipId は除外)。 */
export function collectClipEdges(project: Project, excludeClipIds: ReadonlySet<string>): number[] {
  const edges: number[] = [];
  for (const track of [...project.videoTracks, ...project.audioTracks]) {
    for (const clip of track.clips) {
      if (excludeClipIds.has(clip.id)) continue;
      edges.push(clip.start, clip.start + clip.duration);
    }
  }
  return edges;
}

/**
 * value に最も近い候補が閾値内にあればそれにスナップする。
 * 複数候補が閾値内にある場合は最も近いものを採用する。
 */
export function snapValue(value: number, candidates: readonly number[], thresholdSec: number): number {
  let best = value;
  let bestDist = thresholdSec;
  for (const c of candidates) {
    const d = Math.abs(c - value);
    if (d <= bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/**
 * クリップの開始位置を、開始端・終了端どちらのスナップも考慮して求める。
 * 閾値内で最も近い候補(開始端 or 終了端)に合わせて start を補正する。
 */
export function snapClipStart(
  desiredStart: number,
  duration: number,
  candidates: readonly number[],
  thresholdSec: number,
): number {
  let bestStart = desiredStart;
  let bestDist = thresholdSec;
  const desiredEnd = desiredStart + duration;
  for (const c of candidates) {
    const dStart = Math.abs(c - desiredStart);
    if (dStart <= bestDist) {
      bestDist = dStart;
      bestStart = c;
    }
    const dEnd = Math.abs(c - desiredEnd);
    if (dEnd <= bestDist) {
      bestDist = dEnd;
      bestStart = c - duration;
    }
  }
  return bestStart;
}
