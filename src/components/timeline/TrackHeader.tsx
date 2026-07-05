// トラックヘッダー(DESIGN.md §9)。名前(ダブルクリックでリネーム)、ロック/ミュートの
// トグルアイコン、右クリックでの削除メニュー(最後の 1 本は削除不可)を担う。
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { IconLock, IconSpeakerOff, IconSpeakerOn, IconUnlock } from "../common/icons";
import { log } from "../../lib/logger";
import { useProjectStore } from "../../stores/projectStore";
import type { Track } from "../../types/model";

export interface TrackHeaderProps {
  track: Track;
  heightPx: number;
  highlighted: boolean;
}

export function TrackHeader({ track, heightPx, highlighted }: TrackHeaderProps): JSX.Element {
  const { t } = useTranslation();
  const videoTrackCount = useProjectStore((s) => s.project.videoTracks.length);
  const audioTrackCount = useProjectStore((s) => s.project.audioTracks.length);
  const canDelete = track.kind === "video" ? videoTrackCount > 1 : audioTrackCount > 1;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(track.name);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!menuPos) return;
    const close = (e: PointerEvent): void => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setMenuPos(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuPos]);

  function commitRename(): void {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed === track.name) return;
    useProjectStore.getState().renameTrack(track.id, trimmed);
    log.info("ui", `トラック名変更: trackId=${track.id} name=${trimmed}`);
  }

  function handleDelete(): void {
    setMenuPos(null);
    if (!canDelete) return;
    useProjectStore.getState().removeTrack(track.id);
    log.info("ui", `トラック削除: trackId=${track.id}`);
  }

  return (
    <div
      className={`timeline-track-header${track.locked ? " timeline-track-header-locked" : ""}${highlighted ? " timeline-track-header-highlighted" : ""}`}
      style={{ height: heightPx }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuPos({ x: e.clientX, y: e.clientY });
      }}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="timeline-track-name-input"
          value={draft}
          aria-label={t("timeline.track.rename")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span
          className="timeline-track-name"
          onDoubleClick={() => {
            setDraft(track.name);
            setEditing(true);
          }}
          title={t("timeline.track.rename")}
        >
          {track.name}
        </span>
      )}

      <div className="row timeline-track-toggles">
        <button
          className={`btn btn-icon${track.locked ? " btn-active" : ""}`}
          title={track.locked ? t("timeline.track.unlock") : t("timeline.track.lock")}
          onClick={() => {
            useProjectStore.getState().setTrackLocked(track.id, !track.locked);
            log.info("ui", `トラックロック切替: trackId=${track.id} locked=${!track.locked}`);
          }}
        >
          {track.locked ? <IconLock size={13} /> : <IconUnlock size={13} />}
        </button>
        <button
          className={`btn btn-icon${track.muted ? " btn-active" : ""}`}
          title={track.muted ? t("timeline.track.unmute") : t("timeline.track.mute")}
          onClick={() => {
            useProjectStore.getState().setTrackMuted(track.id, !track.muted);
            log.info("ui", `トラックミュート切替: trackId=${track.id} muted=${!track.muted}`);
          }}
        >
          {track.muted ? <IconSpeakerOff size={13} /> : <IconSpeakerOn size={13} />}
        </button>
      </div>

      {menuPos && (
        <div ref={menuRef} className="context-menu" style={{ left: menuPos.x, top: menuPos.y }}>
          <div
            className={`context-menu-item${canDelete ? "" : " context-menu-item-disabled"}`}
            onClick={canDelete ? handleDelete : undefined}
          >
            {t("timeline.track.delete")}
          </div>
        </div>
      )}
    </div>
  );
}
