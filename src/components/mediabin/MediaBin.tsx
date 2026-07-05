// メディアビン(DESIGN.md §9)。ファイルダイアログ + OS D&D による取込、
// グリッド表示、右クリック削除、Timeline へのポインタドラッグ開始を担う。
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { IconMusic, IconPlus, IconSpinner } from "../common/icons";
import { generateThumbnail, probeMedia } from "../../lib/ipc";
import { log } from "../../lib/logger";
import { formatDurationShort } from "../../lib/time";
import { useProjectStore } from "../../stores/projectStore";
import { useUIStore } from "../../stores/uiStore";
import type { MediaAsset } from "../../types/model";

const VIDEO_EXTS = ["mp4", "mov", "mkv", "webm", "avi"];
const AUDIO_EXTS = ["mp3", "wav", "aac", "flac", "ogg", "m4a"];
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];

function extOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(idx + 1).toLowerCase();
}

function isSupportedExt(path: string): boolean {
  const ext = extOf(path);
  return VIDEO_EXTS.includes(ext) || AUDIO_EXTS.includes(ext) || IMAGE_EXTS.includes(ext);
}

const DRAG_THRESHOLD_PX = 4;

export function MediaBin(): JSX.Element {
  const { t } = useTranslation();
  const assets = useProjectStore((s) => s.project.assets);
  const selectedAssetId = useUIStore((s) => s.selectedAssetId);
  const draggingAsset = useUIStore((s) => s.draggingAsset);

  const [dragOver, setDragOver] = useState(false);
  const [importingCount, setImportingCount] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ assetId: string; x: number; y: number } | null>(null);

  const importErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  function showImportError(message: string): void {
    setImportError(message);
    if (importErrorTimer.current) clearTimeout(importErrorTimer.current);
    importErrorTimer.current = setTimeout(() => setImportError(null), 4000);
  }

  async function importPaths(paths: string[]): Promise<void> {
    const supported = paths.filter(isSupportedExt);
    const skipped = paths.length - supported.length;
    if (skipped > 0) {
      log.info("ui", `メディア取込スキップ(未対応拡張子): ${skipped} 件`);
    }
    for (const path of supported) {
      setImportingCount((c) => c + 1);
      try {
        const probed = await probeMedia(path);
        log.info("ui", `メディア取込開始: path=${path} kind=${probed.kind}`);
        let thumbnail: string | null = null;
        if (probed.kind !== "audio") {
          const timeSec = probed.kind === "video" ? Math.min(1, probed.duration / 2) : 0;
          try {
            thumbnail = await generateThumbnail(probed.id, path, timeSec);
          } catch (err) {
            log.error("ui", `サムネイル生成に失敗しました: path=${path} err=${String(err)}`);
          }
        }
        const asset: MediaAsset = { ...probed, thumbnail };
        useProjectStore.getState().addAsset(asset);
        log.info("ui", `アセット追加: id=${asset.id} name=${asset.name} kind=${asset.kind}`);
      } catch (err) {
        log.error("ui", `メディア取込に失敗しました: path=${path} err=${String(err)}`);
        showImportError(t("mediabin.importFailed"));
      } finally {
        setImportingCount((c) => c - 1);
      }
    }
  }

  async function handleAddMedia(): Promise<void> {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: t("mediabin.videoFilterName"), extensions: VIDEO_EXTS },
          { name: t("mediabin.audioFilterName"), extensions: AUDIO_EXTS },
          { name: t("mediabin.imageFilterName"), extensions: IMAGE_EXTS },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await importPaths(paths);
    } catch (err) {
      log.error("ui", `メディア追加ダイアログでエラーが発生しました: ${String(err)}`);
    }
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragOver(true);
        } else if (payload.type === "leave") {
          setDragOver(false);
        } else if (payload.type === "drop") {
          setDragOver(false);
          log.info("ui", `D&D 受領パス: ${payload.paths.join(", ")}`);
          void importPaths(payload.paths);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err: unknown) => {
        log.error("ui", `D&D の初期化に失敗しました: ${String(err)}`);
      });
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleItemPointerDown(e: ReactPointerEvent<HTMLDivElement>, asset: MediaAsset): void {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const handleMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        dragging = true;
        useUIStore.getState().setDraggingAsset({
          assetId: asset.id,
          kind: asset.kind,
          duration: asset.kind === "image" ? 5 : asset.duration,
        });
        log.info("ui", `MediaBin ドラッグ開始: assetId=${asset.id}`);
      }
      if (dragging) setGhostPos({ x: ev.clientX, y: ev.clientY });
    };

    const handleUp = (): void => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      setGhostPos(null);
      if (dragging) {
        // Timeline(P3)側の pointerup 処理が draggingAsset を読み終えてからクリアする。
        setTimeout(() => useUIStore.getState().setDraggingAsset(null), 0);
      } else {
        useUIStore.getState().setSelectedAssetId(asset.id);
        log.info("ui", `アセット選択: id=${asset.id}`);
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: PointerEvent): void => {
      // メニュー内部でのクリックは項目の onClick を先に発火させたいので閉じない。
      if (contextMenuRef.current && e.target instanceof Node && contextMenuRef.current.contains(e.target)) {
        return;
      }
      setContextMenu(null);
    };
    const closeOnKey = (): void => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnKey);
    };
  }, [contextMenu]);

  function handleDeleteAsset(assetId: string): void {
    useProjectStore.getState().removeAsset(assetId);
    log.info("ui", `アセット削除: id=${assetId}`);
    setContextMenu(null);
  }

  const draggingAssetName = draggingAsset
    ? (assets.find((a) => a.id === draggingAsset.assetId)?.name ?? null)
    : null;

  return (
    <div className={`mediabin-panel${dragOver ? " mediabin-dragover" : ""}`}>
      <div className="mediabin-header">
        <button className="btn" onClick={() => void handleAddMedia()}>
          <IconPlus size={14} />
          {t("mediabin.addMedia")}
        </button>
        {importingCount > 0 && (
          <span className="row mediabin-importing">
            <IconSpinner size={14} />
            {t("mediabin.importing")}
          </span>
        )}
      </div>

      {importError && <div className="mediabin-error">{importError}</div>}

      {assets.length === 0 ? (
        <div className="mediabin-empty">{t("mediabin.empty")}</div>
      ) : (
        <div className="mediabin-grid">
          {assets.map((asset) => (
            <div
              key={asset.id}
              className={`mediabin-item${selectedAssetId === asset.id ? " mediabin-item-selected" : ""}`}
              onPointerDown={(e) => handleItemPointerDown(e, asset)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ assetId: asset.id, x: e.clientX, y: e.clientY });
              }}
            >
              <div className="mediabin-thumb">
                {asset.kind === "audio" ? (
                  <IconMusic size={22} />
                ) : asset.thumbnail ? (
                  <img src={convertFileSrc(asset.thumbnail)} alt="" draggable={false} />
                ) : null}
              </div>
              <div className="mediabin-name" title={asset.name}>
                {asset.name}
              </div>
              {asset.kind !== "image" && (
                <div className="mediabin-duration text-sub">{formatDurationShort(asset.duration)}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {dragOver && <div className="mediabin-dropzone-hint">{t("mediabin.dropHint")}</div>}

      {ghostPos && draggingAssetName && (
        <div className="media-drag-ghost" style={{ left: ghostPos.x, top: ghostPos.y }}>
          {draggingAssetName}
        </div>
      )}

      {contextMenu && (
        <div ref={contextMenuRef} className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <div className="context-menu-item" onClick={() => handleDeleteAsset(contextMenu.assetId)}>
            {t("mediabin.contextDelete")}
          </div>
        </div>
      )}
    </div>
  );
}
