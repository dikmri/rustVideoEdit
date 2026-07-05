// UI 状態(選択・ツール・ズーム・再生状態等)。DESIGN.md §2, §9 の uiStore。
// undo/redo の対象外(zundo は projectStore のみ)。
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type { AssetKind } from "../types/model";

export type Tool = "select" | "razor";

export interface DraggingAsset {
  assetId: string;
  kind: AssetKind;
  duration: number;
}

export const MIN_PX_PER_SECOND = 10;
export const MAX_PX_PER_SECOND = 400;

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

    setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
    setPlaying: (playing) => set({ playing }),
    togglePlaying: () => set((s) => ({ playing: !s.playing })),
    selectClip: (clipId) => set({ selectedClipIds: clipId ? [clipId] : [] }),
    setSelectedClipIds: (ids) => set({ selectedClipIds: ids }),
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
  })),
);
