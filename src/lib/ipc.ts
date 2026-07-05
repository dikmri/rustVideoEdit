// Rust バックエンドの全 IPC コマンドへの型付きラッパ(DESIGN.md §5)。
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ExportSpec, MediaAsset } from "../types/model";

export interface CheckFfmpegResult {
  ffmpeg: string | null;
  ffprobe: string | null;
  version: string | null;
}

export interface ExportProgressEvent {
  jobId: string;
  ratio: number;
  outTimeSec: number;
  speed: number;
}

export interface ExportDoneEvent {
  jobId: string;
  outputPath: string;
}

export interface ExportErrorEvent {
  jobId: string;
  message: string;
}

export async function checkFfmpeg(): Promise<CheckFfmpegResult> {
  return invoke<CheckFfmpegResult>("check_ffmpeg");
}

export async function probeMedia(path: string): Promise<MediaAsset> {
  return invoke<MediaAsset>("probe_media", { path });
}

export async function generateThumbnail(
  assetId: string,
  path: string,
  timeSec: number,
): Promise<string> {
  return invoke<string>("generate_thumbnail", { assetId, path, timeSec });
}

export async function saveProject(path: string, json: string): Promise<void> {
  return invoke<void>("save_project", { path, json });
}

export async function loadProject(path: string): Promise<string> {
  return invoke<string>("load_project", { path });
}

export async function readSettings(): Promise<string> {
  return invoke<string>("read_settings");
}

export async function writeSettings(json: string): Promise<void> {
  return invoke<void>("write_settings", { json });
}

export async function logEvent(
  level: string,
  target: string,
  message: string,
): Promise<void> {
  return invoke<void>("log_event", { level, target, message });
}

export async function startExport(spec: ExportSpec): Promise<string> {
  return invoke<string>("start_export", { spec });
}

export async function cancelExport(jobId: string): Promise<void> {
  return invoke<void>("cancel_export", { jobId });
}

export async function listSystemFonts(): Promise<string[]> {
  return invoke<string[]>("list_system_fonts");
}

export function onExportProgress(
  handler: (event: ExportProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<ExportProgressEvent>("export:progress", (e) => handler(e.payload));
}

export function onExportDone(
  handler: (event: ExportDoneEvent) => void,
): Promise<UnlistenFn> {
  return listen<ExportDoneEvent>("export:done", (e) => handler(e.payload));
}

export function onExportError(
  handler: (event: ExportErrorEvent) => void,
): Promise<UnlistenFn> {
  return listen<ExportErrorEvent>("export:error", (e) => handler(e.payload));
}
