// タイムラインツールバー(DESIGN.md §9)。ツール切替・分割・削除・リップル削除・スナップ・
// テキストクリップ追加・ズーム・トラック追加。分割/削除/リップル削除/テキスト追加は
// lib/shortcuts.ts の共有アクションを呼び、対応するキーボードショートカットと実装を一本化する。
import { useTranslation } from "react-i18next";

import {
  IconCursorArrow,
  IconFitScreen,
  IconPlus,
  IconRippleDelete,
  IconScissors,
  IconSnap,
  IconTextT,
  IconTrash,
} from "../common/icons";
import { log } from "../../lib/logger";
import {
  addTextClipAtPlayhead,
  deleteSelectedClips,
  rippleDeleteSelectedClips,
  splitSelectedAtPlayhead,
} from "../../lib/shortcuts";
import { useProjectStore } from "../../stores/projectStore";
import { MAX_PX_PER_SECOND, MIN_PX_PER_SECOND, useUIStore } from "../../stores/uiStore";

export interface TimelineToolbarProps {
  onZoomFit: () => void;
}

export function TimelineToolbar({ onZoomFit }: TimelineToolbarProps): JSX.Element {
  const { t } = useTranslation();
  const tool = useUIStore((s) => s.tool);
  const snapEnabled = useUIStore((s) => s.snapEnabled);
  const pxPerSecond = useUIStore((s) => s.pxPerSecond);
  const hasSelection = useUIStore((s) => s.selectedClipIds.length > 0);

  function handleAddTrack(kind: "video" | "audio"): void {
    const id = useProjectStore.getState().addTrack(kind);
    log.info("ui", `トラック追加: kind=${kind} trackId=${id}`);
  }

  function handleToggleSnap(): void {
    useUIStore.getState().toggleSnap();
    log.info("ui", `スナップ切替: ${!snapEnabled}`);
  }

  return (
    <div className="timeline-toolbar row">
      <div className="row timeline-toolbar-group">
        <button
          className={`btn btn-icon${tool === "select" ? " btn-active" : ""}`}
          title={t("timeline.toolbar.selectTool")}
          onClick={() => useUIStore.getState().setTool("select")}
        >
          <IconCursorArrow size={15} />
        </button>
        <button
          className={`btn btn-icon${tool === "razor" ? " btn-active" : ""}`}
          title={t("timeline.toolbar.razorTool")}
          onClick={() => useUIStore.getState().setTool("razor")}
        >
          <IconScissors size={15} />
        </button>
      </div>

      <div className="timeline-toolbar-divider" />

      <div className="row timeline-toolbar-group">
        <button
          className="btn btn-icon"
          title={t("timeline.toolbar.split")}
          disabled={!hasSelection}
          onClick={splitSelectedAtPlayhead}
        >
          <IconScissors size={15} />
        </button>
        <button
          className="btn btn-icon"
          title={t("timeline.toolbar.delete")}
          disabled={!hasSelection}
          onClick={deleteSelectedClips}
        >
          <IconTrash size={15} />
        </button>
        <button
          className="btn btn-icon"
          title={t("timeline.toolbar.rippleDelete")}
          disabled={!hasSelection}
          onClick={rippleDeleteSelectedClips}
        >
          <IconRippleDelete size={15} />
        </button>
      </div>

      <div className="timeline-toolbar-divider" />

      <button
        className={`btn btn-icon${snapEnabled ? " btn-active" : ""}`}
        title={snapEnabled ? t("timeline.toolbar.snapOn") : t("timeline.toolbar.snapOff")}
        onClick={handleToggleSnap}
      >
        <IconSnap size={15} />
      </button>

      <button className="btn btn-icon" title={t("timeline.toolbar.addText")} onClick={addTextClipAtPlayhead}>
        <IconTextT size={15} />
      </button>

      <div className="timeline-toolbar-divider" />

      <div className="row timeline-toolbar-zoom">
        <input
          type="range"
          min={MIN_PX_PER_SECOND}
          max={MAX_PX_PER_SECOND}
          value={pxPerSecond}
          aria-label={t("timeline.toolbar.zoom")}
          onChange={(e) => useUIStore.getState().setPxPerSecond(Number(e.target.value))}
        />
        <button className="btn btn-icon" title={t("timeline.toolbar.zoomFit")} onClick={onZoomFit}>
          <IconFitScreen size={15} />
        </button>
      </div>

      <div className="timeline-toolbar-divider" />

      <div className="row timeline-toolbar-group">
        <button className="btn" title={t("timeline.toolbar.addVideoTrack")} onClick={() => handleAddTrack("video")}>
          <IconPlus size={12} />V
        </button>
        <button className="btn" title={t("timeline.toolbar.addAudioTrack")} onClick={() => handleAddTrack("audio")}>
          <IconPlus size={12} />A
        </button>
      </div>
    </div>
  );
}
