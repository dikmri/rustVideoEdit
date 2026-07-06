// UI 状態(選択・ツール・ズーム・再生状態等)。DESIGN.md §2, §9 の uiStore。
// undo/redo の対象外(zundo は projectStore のみ)。
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type { MosaicSample } from "../lib/mosaic";
import type { AssetKind } from "../types/model";

export type Tool = "select" | "razor";

/** テーマ設定(DESIGN.md §13.1)。settings.json に永続化される。 */
export type ThemePreference = "system" | "light" | "dark";

export interface DraggingAsset {
  assetId: string;
  kind: AssetKind;
  duration: number;
}

export const MIN_PX_PER_SECOND = 10;
export const MAX_PX_PER_SECOND = 400;

/**
 * モザイク領域のドラッグ中(移動/リサイズ/回転/新規作成)の一時ドラフト(§13.2)。
 * projectStore への連打書き込み(undo 履歴汚染)を避けるため、確定前の値をここに保持し、
 * PlaybackEngine のプレビュー描画だけをリアルタイムに追従させる。
 * regionId が null の場合は新規作成ドラッグ中を表す(既存 region ではなく追加領域として描画)。
 * pointerup での確定後、またはドラッグキャンセル(pointercancel/Escape)時に null へ戻す。
 */
export interface MosaicDraft {
  clipId: string;
  regionId: string | null;
  blockSize: number;
  sample: MosaicSample;
}

export interface UIState {
  /** 再生ヘッド位置(秒)。 */
  playhead: number;
  /** 再生中かどうか。 */
  playing: boolean;
  /** 選択中のクリップ ID 一覧。 */
  selectedClipIds: string[];
  /** 選択中の MediaBin アセット ID。 */
  selectedAssetId: string | null;
  /** タイムラインツール。 */
  tool: Tool;
  /** タイムラインのズーム(px/秒)。既定 60。 */
  pxPerSecond: number;
  /** スナップの有効/無効。既定 true。 */
  snapEnabled: boolean;
  /** 保存先の .rvep パス(未保存なら null)。 */
  projectPath: string | null;
  /** 未保存の変更があるか。 */
  dirty: boolean;
  /** MediaBin → Timeline へのポインタドラッグ中のアセット情報。 */
  draggingAsset: DraggingAsset | null;
  /** クリップ移動ドラッグ中、ポインタがホバーしているトラック ID(ハイライト表示用)。 */
  dragHoverTrackId: string | null;
  /** 書き出しダイアログの開閉(P3 が中身を実装)。 */
  exportDialogOpen: boolean;
  /** 設定ダイアログの開閉。 */
  settingsDialogOpen: boolean;
  /** ffmpeg/ffprobe の可用性。未チェックは null。 */
  ffmpegAvailable: boolean | null;
  /** テーマ設定(§13.1)。既定 'system'。適用と永続化は lib/appSettings.ts が担う。 */
  theme: ThemePreference;
  /** 書き出し完了音の有効/無効(§13.4)。既定 true。永続化は lib/appSettings.ts が担う。 */
  soundEnabled: boolean;
  /** モザイク編集モード(§13.2)。選択クリップのレイヤー上に編集オーバーレイを表示する。 */
  mosaicEditMode: boolean;
  /** 選択中のモザイク領域 ID(§13.2)。 */
  selectedMosaicRegionId: string | null;
  /** モザイク領域ドラッグ中の一時ドラフト(§13.2)。ドラッグ中以外は null。 */
  mosaicDraft: MosaicDraft | null;

  setPlayhead: (t: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  selectClip: (clipId: string | null) => void;
  setSelectedClipIds: (ids: string[]) => void;
  setSelectedAssetId: (assetId: string | null) => void;
  setTool: (tool: Tool) => void;
  setPxPerSecond: (px: number) => void;
  setSnapEnabled: (enabled: boolean) => void;
  toggleSnap: () => void;
  setProjectPath: (path: string | null) => void;
  setDirty: (dirty: boolean) => void;
  setDraggingAsset: (dragging: DraggingAsset | null) => void;
  setDragHoverTrackId: (trackId: string | null) => void;
  setExportDialogOpen: (open: boolean) => void;
  setSettingsDialogOpen: (open: boolean) => void;
  setFfmpegAvailable: (available: boolean | null) => void;
  setTheme: (theme: ThemePreference) => void;
  setSoundEnabled: (enabled: boolean) => void;
  setMosaicEditMode: (on: boolean) => void;
  setSelectedMosaicRegionId: (regionId: string | null) => void;
  setMosaicDraft: (draft: MosaicDraft | null) => void;
}

export const useUIStore = create<UIState>()(
  subscribeWithSelector((set) => ({
    playhead: 0,
    playing: false,
    selectedClipIds: [],
    selectedAssetId: null,
    tool: "select",
    pxPerSecond: 60,
    snapEnabled: true,
    projectPath: null,
    dirty: false,
    draggingAsset: null,
    dragHoverTrackId: null,
    exportDialogOpen: false,
    settingsDialogOpen: false,
    ffmpegAvailable: null,
    theme: "system",
    soundEnabled: true,
    mosaicEditMode: false,
    selectedMosaicRegionId: null,
    mosaicDraft: null,

    setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
    setPlaying: (playing) => set({ playing }),
    togglePlaying: () => set((s) => ({ playing: !s.playing })),
    // クリップ選択の変更/解除でモザイク編集モードを終了する(§13.2)。
    selectClip: (clipId) =>
      set((s) => {
        const next = clipId ? [clipId] : [];
        const changed = next.length !== s.selectedClipIds.length || next[0] !== s.selectedClipIds[0];
        return changed
          ? { selectedClipIds: next, mosaicEditMode: false, selectedMosaicRegionId: null }
          : { selectedClipIds: next };
      }),
    setSelectedClipIds: (ids) =>
      set((s) => {
        const changed =
          ids.length !== s.selectedClipIds.length || ids.some((id, i) => id !== s.selectedClipIds[i]);
        return changed
          ? { selectedClipIds: ids, mosaicEditMode: false, selectedMosaicRegionId: null }
          : { selectedClipIds: ids };
      }),
    setSelectedAssetId: (assetId) => set({ selectedAssetId: assetId }),
    setTool: (tool) => set({ tool }),
    setPxPerSecond: (px) =>
      set({ pxPerSecond: Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, px)) }),
    setSnapEnabled: (enabled) => set({ snapEnabled: enabled }),
    toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
    setProjectPath: (path) => set({ projectPath: path }),
    setDirty: (dirty) => set({ dirty }),
    setDraggingAsset: (dragging) => set({ draggingAsset: dragging }),
    setDragHoverTrackId: (trackId) => set({ dragHoverTrackId: trackId }),
    setExportDialogOpen: (open) => set({ exportDialogOpen: open }),
    setSettingsDialogOpen: (open) => set({ settingsDialogOpen: open }),
    setFfmpegAvailable: (available) => set({ ffmpegAvailable: available }),
    setTheme: (theme) => set({ theme }),
    setSoundEnabled: (enabled) => set({ soundEnabled: enabled }),
    setMosaicEditMode: (on) => set(on ? { mosaicEditMode: true } : { mosaicEditMode: false }),
    setSelectedMosaicRegionId: (regionId) => set({ selectedMosaicRegionId: regionId }),
    setMosaicDraft: (draft) => set({ mosaicDraft: draft }),
  })),
);
