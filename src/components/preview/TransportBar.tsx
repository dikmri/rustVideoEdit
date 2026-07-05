// 再生コントロールバー(DESIGN.md §7, §9)。
// Space キーでの再生/停止トグルは lib/shortcuts.ts に一本化されている(ここでは実装しない)。
import { useTranslation } from "react-i18next";

import {
  IconNextFrame,
  IconPause,
  IconPlay,
  IconPrevFrame,
  IconToEnd,
  IconToStart,
} from "../common/icons";
import { log } from "../../lib/logger";
import { formatTimecode } from "../../lib/time";
import { useProjectStore, useTimelineDuration } from "../../stores/projectStore";
import { useUIStore } from "../../stores/uiStore";

export function TransportBar(): JSX.Element {
  const { t } = useTranslation();
  const playhead = useUIStore((s) => s.playhead);
  const playing = useUIStore((s) => s.playing);
  const fps = useProjectStore((s) => s.project.settings.fps);
  const duration = useTimelineDuration();
  const frameDuration = fps > 0 ? 1 / fps : 1 / 30;

  function seekTo(time: number, label: string): void {
    const clamped = Math.max(0, Math.min(duration, time));
    useUIStore.getState().setPlayhead(clamped);
    log.info("ui", `シーク: ${label} -> ${clamped.toFixed(3)}s`);
  }

  function handleToggle(): void {
    const next = !playing;
    useUIStore.getState().setPlaying(next);
    log.info("ui", next ? "再生開始" : "再生停止");
  }

  const disabled = duration <= 0;

  return (
    <div className="transport-bar">
      <button
        className="btn btn-icon"
        title={t("transport.toStart")}
        aria-label={t("transport.toStart")}
        disabled={disabled}
        onClick={() => seekTo(0, "先頭")}
      >
        <IconToStart />
      </button>
      <button
        className="btn btn-icon"
        title={t("transport.prevFrame")}
        aria-label={t("transport.prevFrame")}
        disabled={disabled}
        onClick={() => seekTo(playhead - frameDuration, "1フレーム戻る")}
      >
        <IconPrevFrame />
      </button>
      <button
        className="btn btn-icon"
        title={playing ? t("transport.pause") : t("transport.play")}
        aria-label={playing ? t("transport.pause") : t("transport.play")}
        disabled={disabled}
        onClick={handleToggle}
      >
        {playing ? <IconPause /> : <IconPlay />}
      </button>
      <button
        className="btn btn-icon"
        title={t("transport.nextFrame")}
        aria-label={t("transport.nextFrame")}
        disabled={disabled}
        onClick={() => seekTo(playhead + frameDuration, "1フレーム進む")}
      >
        <IconNextFrame />
      </button>
      <button
        className="btn btn-icon"
        title={t("transport.toEnd")}
        aria-label={t("transport.toEnd")}
        disabled={disabled}
        onClick={() => seekTo(duration, "末尾")}
      >
        <IconToEnd />
      </button>
      <span className="transport-timecode">
        {formatTimecode(playhead, fps)} <span className="text-sub">/ {formatTimecode(duration, fps)}</span>
      </span>
    </div>
  );
}
