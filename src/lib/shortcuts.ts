// キーボードショートカット(DESIGN.md §9 の表を全実装)。App.tsx から installGlobalShortcuts() を
// useEffect で登録する。Space の再生/停止トグルはここに一本化する(TransportBar から移設)。
// Ctrl+N/O/S は lib/projectActions.ts の共有ロジックを呼ぶ(Header と二重実装しない)。
import i18n from "../i18n";
import { useProjectStore, undo, redo } from "../stores/projectStore";
import { useUIStore } from "../stores/uiStore";
import { newProject, openProject, saveProject } from "./projectActions";
import { log } from "./logger";

const ZOOM_STEP_FACTOR = 1.25;
const J_REWIND_SEC = 2;

function translate(key: string): string {
  return i18n.t(key) as string;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** 再生ヘッドの位置で選択中クリップを分割する(ツールバー「分割」ボタンと Ctrl+K で共有)。 */
export function splitSelectedAtPlayhead(): void {
  const ui = useUIStore.getState();
  const store = useProjectStore.getState();
  const playhead = ui.playhead;
  let didSplit = false;
  for (const clipId of ui.selectedClipIds) {
    const track = store.getTrackOfClip(clipId);
    const clip = store.getClipById(clipId);
    if (!track || !clip || track.locked) continue;
    if (playhead <= clip.start || playhead >= clip.start + clip.duration) continue;
    store.splitClip(clipId, playhead);
    didSplit = true;
  }
  if (didSplit) log.info("ui", `クリップ分割(再生ヘッド): playhead=${playhead.toFixed(3)}`);
}

/** 選択中クリップを削除する(ツールバー「削除」ボタンと Delete キーで共有)。 */
export function deleteSelectedClips(): void {
  const ui = useUIStore.getState();
  const store = useProjectStore.getState();
  const ids = ui.selectedClipIds;
  let deleted = false;
  for (const clipId of ids) {
    const track = store.getTrackOfClip(clipId);
    if (!track || track.locked) continue;
    store.removeClip(clipId);
    deleted = true;
  }
  if (deleted) {
    ui.setSelectedClipIds([]);
    log.info("ui", `クリップ削除: ${ids.join(", ")}`);
  }
}

/** 選択中クリップをリップル削除する(ツールバーボタンと Shift+Delete で共有)。 */
export function rippleDeleteSelectedClips(): void {
  const ui = useUIStore.getState();
  const store = useProjectStore.getState();
  const ids = ui.selectedClipIds;
  let deleted = false;
  for (const clipId of ids) {
    const track = store.getTrackOfClip(clipId);
    if (!track || track.locked) continue;
    store.rippleDelete(clipId);
    deleted = true;
  }
  if (deleted) {
    ui.setSelectedClipIds([]);
    log.info("ui", `リップル削除: ${ids.join(", ")}`);
  }
}

/** 選択中クリップの video トラック(なければ V1)の再生ヘッド位置にテキストクリップを追加する。 */
export function addTextClipAtPlayhead(): void {
  const ui = useUIStore.getState();
  const store = useProjectStore.getState();
  const project = store.project;

  let targetTrackId: string | null = null;
  const selectedClip = ui.selectedClipIds.length > 0 ? store.getClipById(ui.selectedClipIds[0]) : null;
  if (selectedClip) {
    const track = store.getTrackOfClip(selectedClip.id);
    if (track && track.kind === "video" && !track.locked) targetTrackId = track.id;
  }
  if (!targetTrackId) {
    targetTrackId = project.videoTracks.find((t) => !t.locked)?.id ?? project.videoTracks[0]?.id ?? null;
  }
  if (!targetTrackId) return;

  const newId = store.addTextClip(targetTrackId, ui.playhead);
  if (newId) {
    ui.setSelectedClipIds([newId]);
    log.info("ui", `テキストクリップ追加: trackId=${targetTrackId} start=${ui.playhead.toFixed(3)}`);
  }
}

export function zoomIn(): void {
  const ui = useUIStore.getState();
  ui.setPxPerSecond(ui.pxPerSecond * ZOOM_STEP_FACTOR);
}

export function zoomOut(): void {
  const ui = useUIStore.getState();
  ui.setPxPerSecond(ui.pxPerSecond / ZOOM_STEP_FACTOR);
}

/**
 * 全ショートカット(DESIGN §9)を window の keydown に登録する。App.tsx が起動時に 1 回呼び、
 * 返り値の解除関数を useEffect のクリーンアップで呼ぶ。
 */
export function installGlobalShortcuts(): () => void {
  function handleKeyDown(e: KeyboardEvent): void {
    if (isEditableTarget(e.target)) return;
    const ui = useUIStore.getState();
    if (ui.exportDialogOpen || ui.settingsDialogOpen) return;

    const mod = e.ctrlKey || e.metaKey;
    const store = useProjectStore.getState();
    const fps = store.project.settings.fps > 0 ? store.project.settings.fps : 30;
    const frameStep = 1 / fps;

    if (mod) {
      if (e.key === "z" || e.key === "Z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        void saveProject(translate);
        return;
      }
      if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        void openProject(translate);
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        void newProject(translate);
        return;
      }
      if (e.key === "e" || e.key === "E") {
        e.preventDefault();
        useUIStore.getState().setExportDialogOpen(true);
        log.info("ui", "書き出しダイアログを開く(Ctrl+E)");
        return;
      }
      if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        splitSelectedAtPlayhead();
        return;
      }
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomIn();
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
        return;
      }
      return; // 未対応の Ctrl 修飾は無視する
    }

    const duration = store.getTimelineDuration();

    switch (e.key) {
      case " ":
        e.preventDefault();
        {
          const next = !ui.playing;
          useUIStore.getState().setPlaying(next);
          log.info("ui", next ? "再生開始(Space)" : "再生停止(Space)");
        }
        break;
      case "j":
      case "J":
        e.preventDefault();
        useUIStore.getState().setPlayhead(Math.max(0, ui.playhead - J_REWIND_SEC));
        log.info("ui", "シーク: J(2秒巻き戻し)");
        break;
      case "k":
      case "K":
        e.preventDefault();
        useUIStore.getState().setPlaying(false);
        log.info("ui", "再生停止(K)");
        break;
      case "l":
      case "L":
        e.preventDefault();
        useUIStore.getState().setPlaying(true);
        log.info("ui", "再生開始(L)");
        break;
      case "ArrowLeft":
        e.preventDefault();
        useUIStore.getState().setPlayhead(Math.max(0, ui.playhead - frameStep));
        break;
      case "ArrowRight":
        e.preventDefault();
        useUIStore.getState().setPlayhead(ui.playhead + frameStep);
        break;
      case "Home":
        e.preventDefault();
        useUIStore.getState().setPlayhead(0);
        break;
      case "End":
        e.preventDefault();
        useUIStore.getState().setPlayhead(duration);
        break;
      case "v":
      case "V":
        useUIStore.getState().setTool("select");
        break;
      case "c":
      case "C":
        useUIStore.getState().setTool("razor");
        break;
      case "t":
      case "T":
        addTextClipAtPlayhead();
        break;
      case "s":
      case "S":
        useUIStore.getState().toggleSnap();
        log.info("ui", `スナップ切替: ${!ui.snapEnabled}`);
        break;
      case "Delete":
        if (e.shiftKey) rippleDeleteSelectedClips();
        else deleteSelectedClips();
        break;
      default:
        break;
    }
  }

  window.addEventListener("keydown", handleKeyDown);
  return () => window.removeEventListener("keydown", handleKeyDown);
}
