// プレビューパネル(DESIGN.md §9): 中央ステージ + 下部 TransportBar。
import { PreviewSurface } from "./PreviewSurface";
import { TransportBar } from "./TransportBar";

export function PreviewPanel(): JSX.Element {
  return (
    <div className="preview-panel">
      <PreviewSurface />
      <TransportBar />
    </div>
  );
}
