// タイムライン本体(DESIGN.md §9)。左に固定 140px の TrackHeader 列、右に Ruler + レーン群が
// 同一スクロールを共有する横スクロール領域。Ctrl+ホイールでカーソル位置を不動点にズーム、
// 通常ホイールで横スクロールする。
import { useLayoutEffect, useRef } from "react";
import type { WheelEvent as ReactWheelEvent } from "react";

import { useProjectStore, useTimelineDuration } from "../../stores/projectStore";
import { MAX_PX_PER_SECOND, MIN_PX_PER_SECOND, useUIStore } from "../../stores/uiStore";
import { Ruler } from "./Ruler";
import { TimelineToolbar } from "./TimelineToolbar";
import { TrackHeader } from "./TrackHeader";
import { TrackLane } from "./TrackLane";
import { CONTENT_EXTRA_SEC, clamp, orderedTracks, RULER_HEIGHT, rowHeightOf, secToPx, TRACK_HEADER_WIDTH } from "./timelineMath";

/** ホイールのズーム感度(Ctrl+ホイール量 → 倍率変換)。 */
const ZOOM_WHEEL_SENSITIVITY = 0.0015;

/** 再生ヘッド縦線。playhead は内部購読とし、rAF 更新中も Timeline 本体全体が
 * 再レンダリングされないよう分離する。 */
function PlayheadLine({ pxPerSecond }: { pxPerSecond: number }): JSX.Element {
  const playhead = useUIStore((s) => s.playhead);
  return <div className="timeline-playhead-line" style={{ left: secToPx(playhead, pxPerSecond) }} />;
}

export function Timeline(): JSX.Element {
  const project = useProjectStore((s) => s.project);
  const duration = useTimelineDuration();
  const tool = useUIStore((s) => s.tool);
  const pxPerSecond = useUIStore((s) => s.pxPerSecond);
  const selectedClipIds = useUIStore((s) => s.selectedClipIds);
  const dragHoverTrackId = useUIStore((s) => s.dragHoverTrackId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesColRef = useRef<HTMLDivElement>(null);
  const pendingScrollAdjust = useRef<number | null>(null);

  const tracks = orderedTracks(project);
  const contentWidthSec = Math.max(duration, 0) + CONTENT_EXTRA_SEC;
  const contentWidthPx = secToPx(contentWidthSec, pxPerSecond);

  useLayoutEffect(() => {
    if (pendingScrollAdjust.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft += pendingScrollAdjust.current;
      pendingScrollAdjust.current = null;
    }
  }, [pxPerSecond]);

  function handleWheel(e: ReactWheelEvent<HTMLDivElement>): void {
    const container = scrollRef.current;
    if (!container) return;

    if (e.ctrlKey) {
      e.preventDefault();
      const lanesEl = lanesColRef.current;
      if (!lanesEl) return;
      const rect = lanesEl.getBoundingClientRect();
      const cursorSec = (e.clientX - rect.left) / pxPerSecond;
      const factor = Math.exp(-e.deltaY * ZOOM_WHEEL_SENSITIVITY);
      const next = clamp(pxPerSecond * factor, MIN_PX_PER_SECOND, MAX_PX_PER_SECOND);
      if (next === pxPerSecond) return;
      pendingScrollAdjust.current = cursorSec * (next - pxPerSecond);
      useUIStore.getState().setPxPerSecond(next);
    } else {
      e.preventDefault();
      container.scrollLeft += e.deltaX !== 0 ? e.deltaX : e.deltaY;
    }
  }

  function handleZoomFit(): void {
    const container = scrollRef.current;
    if (!container || duration <= 0) return;
    const visibleLanesWidth = container.clientWidth - TRACK_HEADER_WIDTH;
    if (visibleLanesWidth <= 0) return;
    const next = clamp(visibleLanesWidth / duration, MIN_PX_PER_SECOND, MAX_PX_PER_SECOND);
    useUIStore.getState().setPxPerSecond(next);
    container.scrollLeft = 0;
  }

  return (
    <div className="timeline-root">
      <TimelineToolbar onZoomFit={handleZoomFit} />
      <div className="timeline-scroll" ref={scrollRef} onWheel={handleWheel}>
        <div className="timeline-inner">
          <div className="timeline-headers-col">
            <div className="timeline-ruler-corner" style={{ height: RULER_HEIGHT }} />
            {tracks.map((track) => (
              <TrackHeader
                key={track.id}
                track={track}
                heightPx={rowHeightOf(track.kind)}
                highlighted={dragHoverTrackId === track.id}
              />
            ))}
          </div>
          <div className="timeline-lanes-col" ref={lanesColRef} style={{ minWidth: contentWidthPx }}>
            <Ruler contentWidthSec={contentWidthSec} pxPerSecond={pxPerSecond} />
            {tracks.map((track) => (
              <TrackLane
                key={track.id}
                track={track}
                pxPerSecond={pxPerSecond}
                contentWidthSec={contentWidthSec}
                tool={tool}
                selectedClipIds={selectedClipIds}
                highlighted={dragHoverTrackId === track.id}
              />
            ))}
            <PlayheadLine pxPerSecond={pxPerSecond} />
          </div>
        </div>
      </div>
    </div>
  );
}
