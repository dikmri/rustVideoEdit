// ルーラー(DESIGN.md §9)。秒目盛の描画とクリック/ドラッグによるシーク、Playhead 三角マーカー。
// 目盛本体は contentWidthSec/pxPerSecond にのみ依存させ、playhead(再生中は rAF で毎フレーム
// 変化する)は三角マーカーだけの小さな子コンポーネントに閉じ込めて再レンダリングを最小化する。
import { useMemo, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { log } from "../../lib/logger";
import { formatDurationShort } from "../../lib/time";
import { useUIStore } from "../../stores/uiStore";
import { chooseTickInterval, clamp, RULER_HEIGHT, secToPx } from "./timelineMath";

export interface RulerProps {
  contentWidthSec: number;
  pxPerSecond: number;
}

function PlayheadTriangle({ pxPerSecond }: { pxPerSecond: number }): JSX.Element {
  const playhead = useUIStore((s) => s.playhead);
  return <div className="timeline-ruler-playhead-tri" style={{ left: secToPx(playhead, pxPerSecond) }} />;
}

export function Ruler({ contentWidthSec, pxPerSecond }: RulerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  function seekFromClientX(clientX: number): void {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const sec = clamp((clientX - rect.left) / pxPerSecond, 0, contentWidthSec);
    useUIStore.getState().setPlayhead(sec);
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return;
    seekFromClientX(e.clientX);

    const handleMove = (ev: PointerEvent): void => seekFromClientX(ev.clientX);
    const handleUp = (): void => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      log.info("ui", `シーク(ルーラー): ${useUIStore.getState().playhead.toFixed(3)}s`);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const ticks = useMemo(() => {
    const interval = chooseTickInterval(pxPerSecond);
    const result: number[] = [];
    for (let t = 0; t <= contentWidthSec + interval; t += interval) {
      result.push(t);
    }
    return result;
  }, [contentWidthSec, pxPerSecond]);

  return (
    <div
      ref={containerRef}
      className="timeline-ruler"
      style={{ width: secToPx(contentWidthSec, pxPerSecond), height: RULER_HEIGHT }}
      onPointerDown={handlePointerDown}
    >
      {ticks.map((t) => (
        <div key={t} className="timeline-ruler-tick" style={{ left: secToPx(t, pxPerSecond) }}>
          <span className="timeline-ruler-tick-line" />
          <span className="timeline-ruler-tick-label">{formatDurationShort(t)}</span>
        </div>
      ))}
      <PlayheadTriangle pxPerSecond={pxPerSecond} />
    </div>
  );
}
