// モザイク編集の共有 UI アクション(DESIGN.md §13.2)。
// ショートカット(Q/E/R/K/H)と PropertiesPanel のボタンから共通で呼ばれる。
// いずれも「現在の補間値をベースにキーフレームを記録する」パターン
// (±半フレーム以内に既存キーフレームがあれば更新、なければ新規追加)。
import { sampleRegion } from "./mosaic";
import { useProjectStore } from "../stores/projectStore";
import { useUIStore } from "../stores/uiStore";
import type { Clip, MediaAsset, MosaicRegion } from "../types/model";

export interface MosaicEditContext {
  clip: Clip;
  asset: MediaAsset;
  region: MosaicRegion;
  /** playhead をクリップローカル秒に変換し 0..duration にクランプした値。 */
  tLocal: number;
}

/** 選択クリップ(video/image)+選択モザイク領域+現在時刻を解決する。無効なら null。 */
export function getMosaicEditContext(): MosaicEditContext | null {
  const ui = useUIStore.getState();
  const store = useProjectStore.getState();
  const clipId = ui.selectedClipIds[0] ?? null;
  if (!clipId) return null;
  const clip = store.getClipById(clipId);
  if (!clip || clip.assetId === null || clip.text !== null) return null;
  const asset = store.project.assets.find((a) => a.id === clip.assetId) ?? null;
  if (!asset || asset.kind === "audio") return null;
  const region = clip.mosaics.find((r) => r.id === ui.selectedMosaicRegionId) ?? null;
  if (!region) return null;
  const tLocal = Math.min(Math.max(ui.playhead - clip.start, 0), clip.duration);
  return { clip, asset, region, tLocal };
}

/** 現在位置に(現在の補間値で)キーフレームを追加する(K / PropertiesPanel ボタン)。 */
export function recordMosaicKeyframeAtPlayhead(): boolean {
  const ctx = getMosaicEditContext();
  if (!ctx) return false;
  const s = sampleRegion(ctx.region, ctx.tLocal);
  if (!s) return false;
  useProjectStore.getState().upsertMosaicKeyframe(ctx.clip.id, ctx.region.id, { time: ctx.tLocal, ...s });
  return true;
}

/** 選択領域の回転を deltaDeg 度加算してキーフレーム記録する(Q: -5 / E: +5)。 */
export function rotateMosaicRegion(deltaDeg: number): boolean {
  const ctx = getMosaicEditContext();
  if (!ctx) return false;
  const s = sampleRegion(ctx.region, ctx.tLocal);
  if (!s) return false;
  useProjectStore
    .getState()
    .upsertMosaicKeyframe(ctx.clip.id, ctx.region.id, { time: ctx.tLocal, ...s, rotation: s.rotation + deltaDeg });
  return true;
}

/** 選択領域の回転を 0 にリセットしてキーフレーム記録する(R)。 */
export function resetMosaicRegionRotation(): boolean {
  const ctx = getMosaicEditContext();
  if (!ctx) return false;
  const s = sampleRegion(ctx.region, ctx.tLocal);
  if (!s) return false;
  useProjectStore
    .getState()
    .upsertMosaicKeyframe(ctx.clip.id, ctx.region.id, { time: ctx.tLocal, ...s, rotation: 0 });
  return true;
}

/** 選択領域の visible をトグルしてキーフレーム記録する(H)。 */
export function toggleMosaicRegionVisible(): boolean {
  const ctx = getMosaicEditContext();
  if (!ctx) return false;
  const s = sampleRegion(ctx.region, ctx.tLocal);
  if (!s) return false;
  useProjectStore
    .getState()
    .upsertMosaicKeyframe(ctx.clip.id, ctx.region.id, { time: ctx.tLocal, ...s, visible: !s.visible });
  return true;
}
