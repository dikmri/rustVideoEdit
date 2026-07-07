// クリップ表示(DESIGN.md §9)。移動/トリム/分割/選択を pointer イベント自作で処理する
// (HTML5 DnD は使わない)。ロック済みトラックのクリップは操作不可(60% 不透明)。
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { log } from "../../lib/logger";
import { formatDurationShort } from "../../lib/time";
import { useWaveform, type WaveformData } from "../../lib/waveform";
import { useProjectStore } from "../../stores/projectStore";
import { useUIStore } from "../../stores/uiStore";
import type { Tool } from "../../stores/uiStore";
import type { Clip, MediaAsset, Track } from "../../types/model";
import {
  clamp,
  collectClipEdges,
  DRAG_THRESHOLD_PX,
  pxToSec,
  ROW_HEIGHT_AUDIO,
  secToPx,
  SNAP_THRESHOLD_PX,
  snapClipStart,
  snapValue,
} from "./timelineMath";

/** 波形 canvas の描画高さ(px)。audio 行高 - 上下 4px ずつの余白(.timeline-clip の top/bottom)。 */
const WAVEFORM_HEIGHT_PX = ROW_HEIGHT_AUDIO - 8;

/**
 * 波形 canvas を描画する(DESIGN §14.3)。クリップの表示範囲 [inPoint, inPoint+duration*speed] を
 * ソース時間 → バケット(peaks[])へ写像し、上下対称の縦線群で描く。
 */
function drawWaveform(canvas: HTMLCanvasElement, waveform: WaveformData, clip: Clip, widthCss: number): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(widthCss * dpr));
  const h = Math.max(1, Math.round(WAVEFORM_HEIGHT_PX * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  const { peaks, durationSec } = waveform;
  if (peaks.length === 0 || durationSec <= 0) return;

  const sourceStart = clip.inPoint;
  const sourceSpan = clip.duration * clip.speed;
  if (sourceSpan <= 0) return;

  const color = getComputedStyle(canvas).getPropertyValue("--clip-waveform").trim() || "rgba(60, 58, 54, 0.4)";
  ctx.fillStyle = color;

  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const t = sourceStart + ((x + 0.5) / w) * sourceSpan;
    const bucket = Math.min(peaks.length - 1, Math.max(0, Math.floor((t / durationSec) * peaks.length)));
    const amp = Math.min(1, Math.max(0, peaks[bucket] / 100));
    const barH = Math.max(1, amp * mid);
    ctx.fillRect(x, mid - barH, 1, barH * 2);
  }
}

export interface ClipViewProps {
  clip: Clip;
  asset: MediaAsset | null;
  track: Track;
  pxPerSecond: number;
  selected: boolean;
  tool: Tool;
}

interface MoveGhost {
  trackId: string;
  start: number;
}

interface TrimGhost {
  start: number;
  duration: number;
}

const MIN_TRIM_DURATION = 0.05;

function formatSpeed(speed: number): string {
  if (Number.isInteger(speed)) return `${speed}`;
  return speed.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function ClipView({ clip, asset, track, pxPerSecond, selected, tool }: ClipViewProps): JSX.Element {
  const [moveGhost, setMoveGhost] = useState<MoveGhost | null>(null);
  const [trimGhost, setTrimGhost] = useState<TrimGhost | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);

  const locked = track.locked;
  const isText = clip.text !== null;
  const isAudio = asset?.kind === "audio";
  const kindClass = isText ? "timeline-clip-text" : isAudio ? "timeline-clip-audio" : "timeline-clip-video";

  const displayStart = trimGhost ? trimGhost.start : moveGhost ? moveGhost.start : clip.start;
  const displayDuration = trimGhost ? trimGhost.duration : clip.duration;
  const isGhosting = moveGhost !== null || trimGhost !== null;

  const label = asset ? asset.name : (clip.text?.content ?? "");

  const leftPx = secToPx(displayStart, pxPerSecond);
  const widthPx = Math.max(2, secToPx(displayDuration, pxPerSecond));

  // 波形描画(DESIGN §14.3)。未生成の間は useWaveform が null を返し、従来表示(波形なし)のまま。
  const waveform = useWaveform(isAudio ? (asset?.id ?? null) : null);
  useEffect(() => {
    if (!isAudio || !waveform) return;
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    drawWaveform(canvas, waveform, clip, widthPx);
    // clip 全体を依存に含めると無関係な変更でも再描画されるが、トリム/ズーム追従を優先する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAudio, waveform, clip.inPoint, clip.duration, clip.speed, widthPx]);

  function computeSnapCandidates(excludeSelf: boolean): number[] {
    const project = useProjectStore.getState().project;
    const exclude = new Set<string>(excludeSelf ? [clip.id] : []);
    const edges = collectClipEdges(project, exclude);
    const playhead = useUIStore.getState().playhead;
    return [...edges, playhead, 0];
  }

  function handleMovePointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (locked || e.button !== 0) return;
    e.stopPropagation();

    const startClientX = e.clientX;
    const origStart = clip.start;
    let dragging = false;
    let ghost: MoveGhost = { trackId: track.id, start: origStart };
    let lastHoverTrackId = track.id;

    const handleMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - startClientX;
      if (!dragging && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      dragging = true;

      let hoverTrackId = track.id;
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const laneEl = el instanceof Element ? el.closest<HTMLElement>("[data-track-kind]") : null;
      if (
        laneEl &&
        laneEl.dataset.trackKind === track.kind &&
        laneEl.dataset.trackLocked !== "true" &&
        laneEl.dataset.trackId
      ) {
        hoverTrackId = laneEl.dataset.trackId;
      }
      if (hoverTrackId !== lastHoverTrackId) {
        lastHoverTrackId = hoverTrackId;
        useUIStore.getState().setDragHoverTrackId(hoverTrackId);
      }

      const desiredStart = Math.max(0, origStart + pxToSec(dx, pxPerSecond));
      const snapEnabled = useUIStore.getState().snapEnabled;
      const start = snapEnabled
        ? Math.max(
            0,
            snapClipStart(desiredStart, clip.duration, computeSnapCandidates(true), SNAP_THRESHOLD_PX / pxPerSecond),
          )
        : desiredStart;

      ghost = { trackId: hoverTrackId, start };
      setMoveGhost(ghost);
    };

    const handleUp = (ev: PointerEvent): void => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      useUIStore.getState().setDragHoverTrackId(null);
      setMoveGhost(null);

      if (dragging) {
        useProjectStore.getState().moveClip(clip.id, ghost.trackId, ghost.start);
        log.info("ui", `クリップ移動: clipId=${clip.id} trackId=${ghost.trackId} start=${ghost.start.toFixed(3)}`);
      } else {
        const ui = useUIStore.getState();
        if (ev.ctrlKey) {
          const set = new Set(ui.selectedClipIds);
          if (set.has(clip.id)) set.delete(clip.id);
          else set.add(clip.id);
          ui.setSelectedClipIds([...set]);
        } else {
          ui.setSelectedClipIds([clip.id]);
        }
        log.info("ui", `クリップ選択: clipId=${clip.id}`);
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  function handleRazorPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (locked || e.button !== 0) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const localSec = clip.start + pxToSec(e.clientX - rect.left, pxPerSecond);
    const snapEnabled = useUIStore.getState().snapEnabled;
    const atTime = snapEnabled
      ? snapValue(localSec, computeSnapCandidates(false), SNAP_THRESHOLD_PX / pxPerSecond)
      : localSec;
    useProjectStore.getState().splitClip(clip.id, atTime);
    log.info("ui", `クリップ分割: clipId=${clip.id} at=${atTime.toFixed(3)}`);
  }

  function startTrim(edge: "left" | "right", e: ReactPointerEvent<HTMLDivElement>): void {
    if (locked || tool !== "select" || e.button !== 0) return;
    e.stopPropagation();

    const startClientX = e.clientX;
    const origStart = clip.start;
    const origDuration = clip.duration;
    let ghost: TrimGhost = { start: origStart, duration: origDuration };

    // trimClip(projectStore)が最終的に適用する制約(隣接クリップ・ソース実尺)をプレビュー側でも
    // 概ね反映し、ドラッグ中のゴーストと確定結果の見た目の差を減らす。
    const index = track.clips.findIndex((c) => c.id === clip.id);
    const prev = index > 0 ? track.clips[index - 1] : null;
    const next = index >= 0 && index < track.clips.length - 1 ? track.clips[index + 1] : null;
    const isSourcedAsset = asset !== null && asset.kind !== "image";

    const handleMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - startClientX;
      const snapEnabled = useUIStore.getState().snapEnabled;
      const thresholdSec = SNAP_THRESHOLD_PX / pxPerSecond;
      const candidates = snapEnabled ? computeSnapCandidates(true) : [];

      if (edge === "left") {
        let lowerBound = prev ? prev.start + prev.duration : 0;
        if (isSourcedAsset && asset) {
          lowerBound = Math.max(lowerBound, origStart - clip.inPoint / clip.speed);
        }
        let newStart = origStart + pxToSec(dx, pxPerSecond);
        if (snapEnabled) newStart = snapValue(newStart, candidates, thresholdSec);
        newStart = clamp(newStart, lowerBound, origStart + origDuration - MIN_TRIM_DURATION);
        ghost = { start: newStart, duration: origStart + origDuration - newStart };
      } else {
        let upperBound = next ? next.start : Infinity;
        if (isSourcedAsset && asset) {
          upperBound = Math.min(upperBound, origStart + (asset.duration - clip.inPoint) / clip.speed);
        }
        let newEnd = origStart + origDuration + pxToSec(dx, pxPerSecond);
        if (snapEnabled) newEnd = snapValue(newEnd, candidates, thresholdSec);
        newEnd = Math.min(Math.max(newEnd, origStart + MIN_TRIM_DURATION), upperBound);
        ghost = { start: origStart, duration: newEnd - origStart };
      }
      setTrimGhost(ghost);
    };

    const handleUp = (): void => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      setTrimGhost(null);
      const edgeTime = edge === "left" ? ghost.start : ghost.start + ghost.duration;
      useProjectStore.getState().trimClip(clip.id, edge, edgeTime);
      log.info("ui", `クリップトリム: clipId=${clip.id} edge=${edge} time=${edgeTime.toFixed(3)}`);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  return (
    <div
      className={[
        "timeline-clip",
        kindClass,
        selected ? "timeline-clip-selected" : "",
        locked ? "timeline-clip-locked" : "",
        isGhosting ? "timeline-clip-ghost" : "",
        tool === "razor" && !locked ? "timeline-clip-razor" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ left: leftPx, width: widthPx }}
      onPointerDown={tool === "razor" ? handleRazorPointerDown : handleMovePointerDown}
      title={`${label} (${formatDurationShort(clip.duration)})`}
    >
      {isAudio && <canvas ref={waveformCanvasRef} className="timeline-clip-waveform" />}
      {clip.fadeIn > 0 && <span className="timeline-clip-fade-tri-in" />}
      {clip.fadeOut > 0 && <span className="timeline-clip-fade-tri-out" />}
      {clip.transitionIn && (
        <span
          className="timeline-clip-transition-badge"
          title={`${clip.transitionIn.type} ${clip.transitionIn.duration.toFixed(2)}s`}
        />
      )}
      <span className="timeline-clip-label">{label}</span>
      <span className="timeline-clip-duration">{formatDurationShort(displayDuration)}</span>
      {!isText && clip.speed !== 1 && <span className="timeline-clip-speed-badge">×{formatSpeed(clip.speed)}</span>}
      {tool === "select" && !locked && (
        <>
          <div
            className="timeline-clip-handle timeline-clip-handle-left"
            onPointerDown={(e) => startTrim("left", e)}
          />
          <div
            className="timeline-clip-handle timeline-clip-handle-right"
            onPointerDown={(e) => startTrim("right", e)}
          />
        </>
      )}
    </div>
  );
}
