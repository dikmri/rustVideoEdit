// 書き出しダイアログ(DESIGN.md §5, §8, §9)。プリセット選択、詳細設定、保存先選択、
// 書き出し実行(進捗/速度/キャンセル/完了/エラー)を担う。uiStore.exportDialogOpen で開閉する。
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { IconWarning } from "../common/icons";
import { buildExportSpec } from "../../lib/exportSpec";
import {
  cancelExport,
  onExportDone,
  onExportError,
  onExportProgress,
  startExport,
} from "../../lib/ipc";
import { log } from "../../lib/logger";
import { useProjectStore } from "../../stores/projectStore";
import { useUIStore } from "../../stores/uiStore";
import type { VideoCodec } from "../../types/model";
import { DragNumber } from "../properties/DragNumber";

interface Preset {
  key: string;
  labelKey: string;
  codec: VideoCodec;
  width: number | null; // null = プロジェクト解像度
  height: number | null;
  fps: number | null; // null = プロジェクト fps
  quality: number;
  audioBitrateKbps: number;
}

const PRESETS: Preset[] = [
  {
    key: "youtube1080p",
    labelKey: "export.preset.youtube1080p",
    codec: "h264",
    width: 1920,
    height: 1080,
    fps: 30,
    quality: 20,
    audioBitrateKbps: 192,
  },
  {
    key: "uhd4k",
    labelKey: "export.preset.uhd4k",
    codec: "h264",
    width: 3840,
    height: 2160,
    fps: 30,
    quality: 19,
    audioBitrateKbps: 192,
  },
  {
    key: "hd720p",
    labelKey: "export.preset.hd720p",
    codec: "h264",
    width: 1280,
    height: 720,
    fps: 30,
    quality: 21,
    audioBitrateKbps: 192,
  },
  {
    key: "prores",
    labelKey: "export.preset.proresMaster",
    codec: "prores",
    width: null,
    height: null,
    fps: null,
    quality: 20,
    audioBitrateKbps: 320,
  },
];

const FPS_OPTIONS = [24, 30, 60];

type ExportPhase = "idle" | "running" | "done" | "error";

export function ExportDialog(): JSX.Element | null {
  const { t } = useTranslation();
  const open = useUIStore((s) => s.exportDialogOpen);
  const project = useProjectStore((s) => s.project);
  const ffmpegAvailable = useUIStore((s) => s.ffmpegAvailable);

  const [codec, setCodec] = useState<VideoCodec>("h264");
  const [width, setWidth] = useState(project.settings.width);
  const [height, setHeight] = useState(project.settings.height);
  const [fps, setFps] = useState(project.settings.fps || 30);
  const [quality, setQuality] = useState(20);
  const [audioBitrateKbps, setAudioBitrateKbps] = useState(192);
  const [outputPath, setOutputPath] = useState<string | null>(null);

  const [phase, setPhase] = useState<ExportPhase>("idle");
  const [progressRatio, setProgressRatio] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [doneOutputPath, setDoneOutputPath] = useState<string | null>(null);

  const jobIdRef = useRef<string | null>(null);
  const unlistenRefs = useRef<Array<() => void>>([]);

  function cleanupListeners(): void {
    for (const off of unlistenRefs.current) off();
    unlistenRefs.current = [];
  }

  useEffect(() => cleanupListeners, []);

  const matchedPresetKey =
    PRESETS.find(
      (p) =>
        p.codec === codec &&
        (p.width === null ? width === project.settings.width : width === p.width) &&
        (p.height === null ? height === project.settings.height : height === p.height) &&
        (p.fps === null ? fps === (project.settings.fps || 30) : fps === p.fps) &&
        quality === p.quality &&
        audioBitrateKbps === p.audioBitrateKbps,
    )?.key ?? "custom";

  function applyPreset(key: string): void {
    const preset = PRESETS.find((p) => p.key === key);
    if (!preset) return;
    setCodec(preset.codec);
    setWidth(preset.width ?? project.settings.width);
    setHeight(preset.height ?? project.settings.height);
    setFps(preset.fps ?? (project.settings.fps || 30));
    setQuality(preset.quality);
    setAudioBitrateKbps(preset.audioBitrateKbps);
    log.info("ui", `書き出しプリセット選択: ${key}`);
  }

  async function handleBrowse(): Promise<void> {
    const ext = codec === "prores" ? "mov" : "mp4";
    try {
      const selected = await save({
        title: t("export.saveDialogTitle"),
        defaultPath: outputPath ?? `${project.name}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (selected) {
        setOutputPath(selected);
        log.info("ui", `書き出し先選択: ${selected}`);
      }
    } catch (err) {
      log.error("ui", `書き出し先の選択に失敗しました: ${String(err)}`);
    }
  }

  async function handleStart(): Promise<void> {
    if (!outputPath) return;
    const spec = buildExportSpec(project, outputPath, { width, height, fps, videoCodec: codec, quality, audioBitrateKbps });
    log.info(
      "ui",
      `書き出し開始: output=${outputPath} codec=${codec} ${width}x${height}@${fps}fps quality=${quality} ` +
        `audio=${audioBitrateKbps}kbps videoClips=${spec.videoClips.length} audioClips=${spec.audioClips.length} ` +
        `duration=${spec.durationSec.toFixed(2)}s`,
    );
    setPhase("running");
    setProgressRatio(0);
    setSpeed(0);
    setErrorMessage(null);
    try {
      const jobId = await startExport(spec);
      jobIdRef.current = jobId;
      const offProgress = await onExportProgress((e) => {
        if (e.jobId !== jobIdRef.current) return;
        setProgressRatio(e.ratio);
        setSpeed(e.speed);
      });
      const offDone = await onExportDone((e) => {
        if (e.jobId !== jobIdRef.current) return;
        setPhase("done");
        setDoneOutputPath(e.outputPath);
        log.info("ui", `書き出し完了: ${e.outputPath}`);
        cleanupListeners();
      });
      const offError = await onExportError((e) => {
        if (e.jobId !== jobIdRef.current) return;
        setPhase("error");
        setErrorMessage(e.message);
        log.error("ui", `書き出し失敗: ${e.message}`);
        cleanupListeners();
      });
      unlistenRefs.current = [offProgress, offDone, offError];
    } catch (err) {
      setPhase("error");
      setErrorMessage(String(err));
      log.error("ui", `書き出し開始に失敗しました: ${String(err)}`);
    }
  }

  async function handleCancel(): Promise<void> {
    const jobId = jobIdRef.current;
    if (!jobId) return;
    try {
      await cancelExport(jobId);
      log.info("ui", `書き出しキャンセル: jobId=${jobId}`);
    } catch (err) {
      log.error("ui", `書き出しキャンセルに失敗しました: ${String(err)}`);
    } finally {
      cleanupListeners();
      jobIdRef.current = null;
      setPhase("idle");
    }
  }

  async function handleOpenFolder(): Promise<void> {
    if (!doneOutputPath) return;
    try {
      await revealItemInDir(doneOutputPath);
    } catch (err) {
      log.error("ui", `フォルダを開けませんでした: ${String(err)}`);
    }
  }

  function handleClose(): void {
    if (phase === "running") return;
    useUIStore.getState().setExportDialogOpen(false);
    if (phase === "done" || phase === "error") setPhase("idle");
    log.info("ui", "書き出しダイアログを閉じる");
  }

  if (!open) return null;

  const totalClips =
    project.videoTracks.reduce((n, tr) => n + tr.clips.length, 0) +
    project.audioTracks.reduce((n, tr) => n + tr.clips.length, 0);
  const isRunning = phase === "running";
  const canStart = !isRunning && ffmpegAvailable !== false && totalClips > 0 && outputPath !== null;

  return (
    <div className="dialog-overlay" onClick={handleClose}>
      <div className="dialog export-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog-title">{t("export.title")}</h2>

        {ffmpegAvailable === false && (
          <div className="mediabin-error row" style={{ gap: 6, marginBottom: 12 }}>
            <IconWarning size={14} />
            {t("export.ffmpegMissing")}
          </div>
        )}

        <fieldset className="col" style={{ gap: 8, border: "none", padding: 0, margin: 0 }} disabled={isRunning}>
          <div className="properties-row">
            <label>{t("export.preset.label")}</label>
            <select value={matchedPresetKey} onChange={(e) => applyPreset(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {t(p.labelKey)}
                </option>
              ))}
              <option value="custom">{t("export.preset.custom")}</option>
            </select>
          </div>

          <div className="properties-row">
            <label>{t("export.codec")}</label>
            <select value={codec} onChange={(e) => setCodec(e.target.value as VideoCodec)}>
              <option value="h264">{t("export.codec.h264")}</option>
              <option value="hevc">{t("export.codec.hevc")}</option>
              <option value="prores">{t("export.codec.prores")}</option>
            </select>
          </div>

          <div className="properties-row">
            <label>{t("export.width")}</label>
            <DragNumber
              value={width}
              min={16}
              max={7680}
              step={2}
              precision={0}
              disabled={isRunning}
              onChange={setWidth}
            />
          </div>
          <div className="properties-row">
            <label>{t("export.height")}</label>
            <DragNumber
              value={height}
              min={16}
              max={4320}
              step={2}
              precision={0}
              disabled={isRunning}
              onChange={setHeight}
            />
          </div>
          <div className="properties-row">
            <label>{t("export.fps")}</label>
            <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
              {FPS_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <div className="properties-row">
            <label>{t("export.quality")}</label>
            <DragNumber
              value={quality}
              min={15}
              max={30}
              step={1}
              precision={0}
              disabled={isRunning || codec === "prores"}
              onChange={setQuality}
            />
          </div>
          <div className="properties-row">
            <label>{t("export.audioBitrate")}</label>
            <DragNumber
              value={audioBitrateKbps}
              min={96}
              max={320}
              step={1}
              precision={0}
              suffix="kbps"
              disabled={isRunning || codec === "prores"}
              onChange={setAudioBitrateKbps}
            />
          </div>

          <div className="properties-row">
            <label>{t("export.outputPath")}</label>
            <input type="text" readOnly value={outputPath ?? ""} title={outputPath ?? ""} />
            <button className="btn" onClick={() => void handleBrowse()}>
              {t("export.browse")}
            </button>
          </div>
        </fieldset>

        {totalClips === 0 && <div className="text-sub" style={{ fontSize: 11 }}>{t("export.noClips")}</div>}

        {phase === "running" && (
          <div className="col" style={{ gap: 6, marginTop: 12 }}>
            <div className="export-progress-track">
              <div className="export-progress-fill" style={{ width: `${Math.round(progressRatio * 100)}%` }} />
            </div>
            <div className="row text-sub" style={{ gap: 12, fontSize: 11 }}>
              <span>{t("export.progress")}</span>
              <span>{Math.round(progressRatio * 100)}%</span>
              <span>
                {t("export.speed")}: ×{speed.toFixed(2)}
              </span>
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="row" style={{ gap: 8, marginTop: 12, alignItems: "center" }}>
            <span>{t("export.done")}</span>
            <button className="btn" onClick={() => void handleOpenFolder()}>
              {t("export.openFolder")}
            </button>
          </div>
        )}

        {phase === "error" && errorMessage && (
          <div className="col" style={{ gap: 4, marginTop: 12 }}>
            <span>{t("export.error")}</span>
            <div className="export-error-box">{errorMessage}</div>
          </div>
        )}

        <div className="dialog-actions">
          {isRunning ? (
            <button className="btn" onClick={() => void handleCancel()}>
              {t("export.cancel")}
            </button>
          ) : (
            <>
              <button className="btn" onClick={handleClose}>
                {t("export.close")}
              </button>
              <button className="btn btn-accent" disabled={!canStart} onClick={() => void handleStart()}>
                {t("export.start")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
