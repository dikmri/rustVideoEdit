// プロジェクト全体アクション(新規/開く/保存/名前を付けて保存)。
// Header.tsx のボタンと shortcuts.ts の Ctrl+N/O/S から共有する単一実装(DESIGN.md §9)。
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";

import { loadProject as ipcLoadProject, saveProject as ipcSaveProject } from "./ipc";
import { log } from "./logger";
import { clearHistory, useProjectStore } from "../stores/projectStore";
import { useUIStore } from "../stores/uiStore";
import type { Project } from "../types/model";

const PROJECT_FILTER_EXT = ["rvep"];

/** i18next の t() 相当(単純なキー→文字列変換のみ使用)。 */
export type Translate = (key: string) => string;

function resetUiForFreshProject(path: string | null): void {
  useUIStore.getState().setSelectedClipIds([]);
  useUIStore.getState().setSelectedAssetId(null);
  useUIStore.getState().setPlayhead(0);
  useUIStore.getState().setPlaying(false);
  useUIStore.getState().setProjectPath(path);
  useUIStore.getState().setDirty(false);
  clearHistory();
}

/** 未保存の変更があれば ask() で破棄確認する。続行してよい場合のみ true。 */
async function confirmDiscardIfDirty(t: Translate): Promise<boolean> {
  if (!useUIStore.getState().dirty) return true;
  return ask(t("header.confirmDiscardMessage"), {
    title: t("header.confirmDiscardTitle"),
    kind: "warning",
  });
}

export async function newProject(t: Translate): Promise<void> {
  const ok = await confirmDiscardIfDirty(t);
  if (!ok) return;
  useProjectStore.getState().newProject();
  resetUiForFreshProject(null);
  log.info("ui", "新規プロジェクト作成");
}

export async function openProject(t: Translate): Promise<void> {
  const ok = await confirmDiscardIfDirty(t);
  if (!ok) return;
  try {
    const selected = await open({
      multiple: false,
      filters: [{ name: t("header.projectFileFilterName"), extensions: PROJECT_FILTER_EXT }],
    });
    if (!selected || Array.isArray(selected)) return;
    const json = await ipcLoadProject(selected);
    const project = JSON.parse(json) as Project;
    useProjectStore.getState().loadProject(project);
    resetUiForFreshProject(selected);
    log.info("ui", `プロジェクト読込: ${selected}`);
  } catch (err) {
    log.error("ui", `プロジェクトの読込に失敗しました: ${String(err)}`);
    await message(t("header.loadFailed"), { title: t("app.name"), kind: "error" });
  }
}

async function writeProjectTo(path: string): Promise<void> {
  const project = useProjectStore.getState().project;
  const json = JSON.stringify(project, null, 2);
  await ipcSaveProject(path, json);
  useUIStore.getState().setProjectPath(path);
  useUIStore.getState().setDirty(false);
  log.info("ui", `プロジェクト保存: ${path}`);
}

export async function saveProjectAs(t: Translate): Promise<void> {
  try {
    const projectName = useProjectStore.getState().project.name;
    const projectPath = useUIStore.getState().projectPath;
    const defaultPath = projectPath ?? `${projectName}.rvep`;
    const selected = await save({
      defaultPath,
      filters: [{ name: t("header.projectFileFilterName"), extensions: PROJECT_FILTER_EXT }],
    });
    if (!selected) return;
    await writeProjectTo(selected);
  } catch (err) {
    log.error("ui", `プロジェクトの保存に失敗しました: ${String(err)}`);
    await message(t("header.saveFailed"), { title: t("app.name"), kind: "error" });
  }
}

export async function saveProject(t: Translate): Promise<void> {
  const projectPath = useUIStore.getState().projectPath;
  if (!projectPath) {
    await saveProjectAs(t);
    return;
  }
  try {
    await writeProjectTo(projectPath);
  } catch (err) {
    log.error("ui", `プロジェクトの保存に失敗しました: ${String(err)}`);
    await message(t("header.saveFailed"), { title: t("app.name"), kind: "error" });
  }
}
