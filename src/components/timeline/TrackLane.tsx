// トラックレーン(DESIGN.md §9)。クリップ描画、MediaBin からのドロップ受け、
// 背景クリックでの選択解除を担う。クリップ自体の移動/トリム/分割は ClipView が処理する。
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { log } from "../../lib/logger";
import { useProjectStore } from "../../stores/projectStore";
import { useUIStore } from "../../stores/uiStore";
import type { Tool } from "../../stores/uiStore";
import type { Track } from "../../types/model";
import { ClipView } from "./ClipView";
import { clamp, collectClipEdges, pxToSec, rowHeightOf, secToPx, SNAP_THRESHOLD_PX, snapClipStart } from "./timelineMath";

export interface TrackLaneProps {
  track: Track;
  pxPerSecond: number;
  contentWidthSec: number;
  tool: Tool;
  selectedClipIds: string[];
  highlighted: boolean;
}

interface DropPreview {
  x: number;
  widthPx: number;
  startSec: number;
}

export function TrackLane({
  track,
  pxPerSecond,
  contentWidthSec,
  tool,
  selectedClipIds,
  highlighted,
}: TrackLaneProps): JSX.Element {
  const assets = useProjectStore((s) => s.project.assets);
  const draggingAsset = useUIStore((s) => s.draggingAsset);
  const laneRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<DropPreview | null>(null);

  const compatible =
    draggingAsset !== null &&
    !track.locked &&
    (track.kind === "video" ? draggingAsset.kind !== "audio" : draggingAsset.kind === "audio");

  useEffect(() => {
    if (!draggingAsset) {
      setPreview(null);
      return;
    }

    function handleMove(ev: PointerEvent): void {
      const el = laneRef.current;
      if (!el || !draggingAsset) return;
      const rect = el.getBoundingClientRect();
      if (ev.clientY < rect.top || ev.clientY > rect.bottom) {
        setPreview(null);
        return;
      }
      const rawStart = Math.max(0, pxToSec(ev.clientX - rect.left, pxPerSecond));
      const snapEnabled = useUIStore.getState().snapEnabled;
      let startSec = rawStart;
      if (snapEnabled) {
        const project = useProjectStore.getState().project;
        const candidates = [...collectClipEdges(project, new Set()), useUIStore.getState().playhead, 0];
        const thresholdSec = SNAP_THRESHOLD_PX / pxPerSecond;
        startSec = clamp(snapClipStart(rawStart, draggingAsset.duration, candidates, thresholdSec), 0, Infinity);
      }
      setPreview({
        x: secToPx(startSec, pxPerSecond),
        widthPx: secToPx(draggingAsset.duration, pxPerSecond),
        startSec,
      });
    }

    window.addEventListener("pointermove", handleMove);
    return () => window.removeEventListener("pointermove", handleMove);
  }, [draggingAsset, pxPerSecond]);

  function handlePointerUp(): void {
    const dragging = useUIStore.getState().draggingAsset;
    if (!dragging || !preview || !compatible) return;
    const newId = useProjectStore.getState().addClipFromAsset(dragging.assetId, track.id, preview.startSec);
    if (newId) {
      log.info(
        "ui",
        `クリップ追加(ドロップ): trackId=${track.id} assetId=${dragging.assetId} start=${preview.startSec.toFixed(3)}`,
      );
      useUIStore.getState().setSelectedClipIds([newId]);
    }
    setPreview(null);
  }

  function handleBackgroundPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    if (useUIStore.getState().draggingAsset) return;
    useUIStore.getState().setSelectedClipIds([]);
  }

  const widthPx = secToPx(contentWidthSec, pxPerSecond);
  const heightPx = rowHeightOf(track.kind);
  const showInvalidCursor = draggingAsset !== null && !compatible;

  return (
    <div
      ref={laneRef}
      className={[
        "timeline-lane",
        `timeline-lane-${track.kind}`,
        track.locked ? "timeline-lane-locked" : "",
        highlighted ? "timeline-lane-highlighted" : "",
        showInvalidCursor ? "timeline-lane-dropzone-invalid" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ width: widthPx, height: heightPx, cursor: tool === "razor" ? "crosshair" : undefined }}
      data-track-id={track.id}
      data-track-kind={track.kind}
      data-track-locked={track.locked ? "true" : "false"}
      onPointerDown={handleBackgroundPointerDown}
      onPointerUp={handlePointerUp}
    >
      {track.clips.map((clip) => (
        <ClipView
          key={clip.id}
          clip={clip}
          asset={clip.assetId ? (assets.find((a) => a.id === clip.assetId) ?? null) : null}
          track={track}
          pxPerSecond={pxPerSecond}
          selected={selectedClipIds.includes(clip.id)}
          tool={tool}
        />
      ))}
      {draggingAsset && preview && (
        <div
          className={`timeline-drop-preview${compatible ? "" : " timeline-drop-preview-invalid"}`}
          style={{ left: preview.x, width: preview.widthPx }}
        />
      )}
    </div>
  );
}
