// アプリのレイアウト(DESIGN.md §9): Header / 3 カラム(MediaBin|Preview|Properties) / Timeline。
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { UpdateBanner } from "./components/dialogs/UpdateBanner";
import { ExportDialog } from "./components/export/ExportDialog";
import { Header } from "./components/layout/Header";
import { MediaBin } from "./components/mediabin/MediaBin";
import { PreviewPanel } from "./components/preview/PreviewPanel";
import { PropertiesPanel } from "./components/properties/PropertiesPanel";
import { Timeline } from "./components/timeline/Timeline";
import { checkFfmpeg } from "./lib/ipc";
import { log } from "./lib/logger";
import { installGlobalShortcuts } from "./lib/shortcuts";
import { useUIStore } from "./stores/uiStore";

const DEFAULT_TIMELINE_HEIGHT_RATIO = 0.4;
const MIN_TIMELINE_HEIGHT = 120;
const MIN_UPPER_HEIGHT = 200;

function App(): JSX.Element {
  const { t } = useTranslation();
  const ffmpegAvailable = useUIStore((s) => s.ffmpegAvailable);
  const [updateInfo, setUpdateInfo] = useState<Update | null>(null);
  const [timelineHeight, setTimelineHeight] = useState<number | null>(null);
  const appRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    log.info("ui", "UI 起動");
  }, []);

  useEffect(() => {
    return installGlobalShortcuts();
  }, []);

  useEffect(() => {
    checkFfmpeg()
      .then((result) => {
        const available = result.ffmpeg !== null && result.ffprobe !== null;
        useUIStore.getState().setFfmpegAvailable(available);
        log.info(
          "ui",
          `ffmpeg 確認: available=${available} ffmpeg=${result.ffmpeg ?? "-"} ffprobe=${result.ffprobe ?? "-"}`,
        );
      })
      .catch((err: unknown) => {
        useUIStore.getState().setFfmpegAvailable(false);
        log.error("ui", `ffmpeg 確認に失敗しました: ${String(err)}`);
      });
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      check()
        .then((result) => {
          if (result) {
            setUpdateInfo(result);
            log.info("ui", `アップデートを検出: v${result.version}`);
          }
        })
        .catch((err: unknown) => {
          // pubkey 未設定の開発中は必ず失敗するが正常動作(DESIGN.md §9)。
          log.error("ui", `アップデート確認に失敗しました: ${String(err)}`);
        });
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  function handleResizerPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    e.preventDefault();
    const appEl = appRef.current;
    if (!appEl) return;
    const rect = appEl.getBoundingClientRect();

    const handleMove = (ev: PointerEvent): void => {
      const fromBottom = rect.bottom - ev.clientY;
      const clamped = Math.min(Math.max(fromBottom, MIN_TIMELINE_HEIGHT), rect.height - MIN_UPPER_HEIGHT);
      setTimelineHeight(clamped);
    };
    const handleUp = (): void => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const timelineStyle =
    timelineHeight !== null
      ? { height: `${timelineHeight}px` }
      : { height: `${DEFAULT_TIMELINE_HEIGHT_RATIO * 100}%` };

  return (
    <div ref={appRef} className="app-root">
      <Header />
      {ffmpegAvailable === false && <div className="ffmpeg-banner">{t("header.ffmpegMissing")}</div>}
      {updateInfo && <UpdateBanner update={updateInfo} />}
      <div className="app-body">
        <aside className="app-col-mediabin">
          <MediaBin />
        </aside>
        <main className="app-col-preview">
          <PreviewPanel />
        </main>
        <aside className="app-col-properties">
          <PropertiesPanel />
        </aside>
      </div>
      <div className="app-timeline-resizer" onPointerDown={handleResizerPointerDown} />
      <div className="app-timeline-area" style={timelineStyle}>
        <Timeline />
      </div>
      <ExportDialog />
    </div>
  );
}

export default App;
