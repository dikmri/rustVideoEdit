// 波形データキャッシュ + 自動生成(DESIGN.md §14.3)。
// assetId → { durationSec, peaks(0..100) } を保持し、ClipView の波形描画・
// PlaybackEngine 以外の UI から購読できるようにする。
// generate_waveform(Rust)は既存 JSON があればスキップして再利用するため、
// ここでの ensureWaveform も「未取得なら発火」の緩い冪等性で十分安全に呼べる。
import { useSyncExternalStore } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import { generateWaveform } from "./ipc";
import { log } from "./logger";
import { useProjectStore } from "../stores/projectStore";
import type { MediaAsset } from "../types/model";

export interface WaveformData {
  version: number;
  durationSec: number;
  peaks: number[];
}

const cache = new Map<string, WaveformData>();
const pending = new Set<string>();
/** 生成に失敗した assetId。project 変更のたびに再試行してログが溢れるのを防ぐ(セッション中は再試行しない)。 */
const failed = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** ClipView 等から購読するための subscribe 関数(useSyncExternalStore 用)。 */
function subscribeWaveforms(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** キャッシュ済みの波形データを同期的に返す(未取得/生成中は null)。 */
export function getWaveform(assetId: string): WaveformData | null {
  return cache.get(assetId) ?? null;
}

/** assetId の波形をキャッシュから購読する React フック。未取得の間は null を返す。 */
export function useWaveform(assetId: string | null): WaveformData | null {
  return useSyncExternalStore(subscribeWaveforms, () => (assetId ? (cache.get(assetId) ?? null) : null));
}

/**
 * assetId の波形生成を非同期で発火する(DESIGN §14.3)。取込完了後・既存プロジェクト読込後の
 * どちらからも安全に呼べるよう、キャッシュ済み/生成中なら即 no-op にする(二重発火防止)。
 */
export function ensureWaveform(assetId: string, path: string): void {
  if (cache.has(assetId) || pending.has(assetId) || failed.has(assetId)) return;
  pending.add(assetId);
  void (async () => {
    try {
      const jsonPath = await generateWaveform(assetId, path);
      const res = await fetch(convertFileSrc(jsonPath));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as WaveformData;
      cache.set(assetId, data);
      log.info(
        "waveform",
        `波形読込完了: assetId=${assetId} peaks=${data.peaks.length} durationSec=${data.durationSec.toFixed(2)}`,
      );
      notify();
    } catch (err) {
      failed.add(assetId);
      log.error("waveform", `波形の生成/読込に失敗しました: assetId=${assetId} err=${String(err)}`);
    } finally {
      pending.delete(assetId);
    }
  })();
}

/** 波形生成の対象となるアセットか(§14.3: audio 全て、video は hasAudio のもの)。 */
function qualifiesForWaveform(asset: MediaAsset): boolean {
  return asset.kind === "audio" || (asset.kind === "video" && asset.hasAudio);
}

/**
 * projectStore の assets 変化を監視し、対象アセットの波形生成を発火する(DESIGN §14.3)。
 * MediaBin での新規取込直後、および既存プロジェクト読込直後(既存アセットへの遅延生成)の
 * どちらもこの単一の購読でカバーする。App 起動時に 1 回呼び出す。
 */
export function installWaveformAutoGeneration(): () => void {
  function scan(): void {
    for (const asset of useProjectStore.getState().project.assets) {
      if (qualifiesForWaveform(asset)) ensureWaveform(asset.id, asset.path);
    }
  }
  scan();
  return useProjectStore.subscribe(scan);
}
