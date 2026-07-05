// プロジェクトアスペクト比を保つ黒ステージ(DESIGN.md §7, §9)。
// ResizeObserver で外枠のサイズに追従し、プロジェクト座標→表示座標への
// スケーリングを CSS transform: scale で行う。実体レイヤーは PlaybackEngine が管理する。
import { useEffect, useRef, useState } from "react";

import { playbackEngine } from "../../lib/playback/PlaybackEngine";
import { useProjectStore } from "../../stores/projectStore";

export function PreviewSurface(): JSX.Element {
  const width = useProjectStore((s) => s.project.settings.width);
  const height = useProjectStore((s) => s.project.settings.height);

  const outerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;

    const update = (): void => {
      const rect = outer.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) return;
      const next = Math.min(rect.width / width, rect.height / height);
      setScale(next > 0 ? next : 1);
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(outer);
    return () => ro.disconnect();
  }, [width, height]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    playbackEngine.mount(stage);
    return () => playbackEngine.dispose();
  }, []);

  return (
    <div ref={outerRef} className="preview-surface">
      <div
        ref={stageRef}
        className="preview-stage"
        style={{
          width: `${width}px`,
          height: `${height}px`,
          transform: `scale(${scale})`,
        }}
      />
    </div>
  );
}
