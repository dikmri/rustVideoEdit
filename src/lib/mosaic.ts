// モザイクのキーフレーム補間ユーティリティ(DESIGN.md §13.2)。
// プレビュー(PlaybackEngine)と編集 UI で共有する。補間規則は Rust 側
// (filtergraph.rs の区分線形式)と同一: cx/cy/w/h/rotation は隣接キーフレーム間で
// 線形補間、最初より前・最後より後はホールド。visible はステップ(左側キーフレームの値)。
// キーフレームが 1 個なら常にその値。
import type { MosaicKeyframe, MosaicRegion } from "../types/model";

/** blockSize の許容範囲(§13.2)。 */
export const MOSAIC_BLOCK_SIZE_MIN = 4;
export const MOSAIC_BLOCK_SIZE_MAX = 80;
export const MOSAIC_BLOCK_SIZE_DEFAULT = 16;

export interface MosaicSample {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
  visible: boolean;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * クリップローカル時刻 tLocal(秒)における領域の補間値を返す。
 * keyframes は time 昇順・1 個以上を前提とする(空なら null を返す防御のみ行う)。
 */
export function sampleRegion(region: MosaicRegion, tLocal: number): MosaicSample | null {
  const kfs = region.keyframes;
  if (kfs.length === 0) return null;
  if (kfs.length === 1 || tLocal <= kfs[0].time) {
    const k = kfs[0];
    return { cx: k.cx, cy: k.cy, w: k.w, h: k.h, rotation: k.rotation, visible: k.visible };
  }
  const last = kfs[kfs.length - 1];
  if (tLocal >= last.time) {
    return { cx: last.cx, cy: last.cy, w: last.w, h: last.h, rotation: last.rotation, visible: last.visible };
  }
  // tLocal を挟む区間 [a, b) を探す。
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (tLocal >= a.time && tLocal < b.time) {
      const span = b.time - a.time;
      const t = span > 0 ? (tLocal - a.time) / span : 0;
      return {
        cx: lerp(a.cx, b.cx, t),
        cy: lerp(a.cy, b.cy, t),
        w: lerp(a.w, b.w, t),
        h: lerp(a.h, b.h, t),
        rotation: lerp(a.rotation, b.rotation, t),
        visible: a.visible, // ステップ(左側キーフレームの値)
      };
    }
  }
  // 到達しないはずだが防御的に末尾値を返す。
  return { cx: last.cx, cy: last.cy, w: last.w, h: last.h, rotation: last.rotation, visible: last.visible };
}

/** 同時刻キーフレームとみなす許容差(秒)。±半フレーム(§P6a: 1/(2*fps))。 */
export function sameTimeTolerance(fps: number): number {
  const safeFps = fps > 0 ? fps : 30;
  return 1 / (2 * safeFps);
}

/** time が既存キーフレームと同時刻(±tolerance)ならその index、なければ -1 を返す。 */
export function findKeyframeIndexAt(keyframes: MosaicKeyframe[], time: number, tolerance: number): number {
  return keyframes.findIndex((k) => Math.abs(k.time - time) <= tolerance);
}

/**
 * キーフレーム列に kf を挿入または更新した新しい配列を返す(time 昇順を維持)。
 * kf.time と ±tolerance 以内の既存キーフレームがあればそれを置換、なければ挿入する。
 */
export function upsertKeyframe(
  keyframes: MosaicKeyframe[],
  kf: MosaicKeyframe,
  tolerance: number,
): MosaicKeyframe[] {
  const idx = findKeyframeIndexAt(keyframes, kf.time, tolerance);
  if (idx !== -1) {
    const next = [...keyframes];
    // 既存の time を保持したまま値を更新する(±半フレームのゆらぎで時刻が動かないように)。
    next[idx] = { ...kf, time: keyframes[idx].time };
    return next;
  }
  const next = [...keyframes, { ...kf }];
  next.sort((a, b) => a.time - b.time);
  return next;
}
