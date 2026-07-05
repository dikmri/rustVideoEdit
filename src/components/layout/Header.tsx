// ヘッダー(DESIGN.md §9)。プロジェクト名インライン編集、新規/開く/保存/名前を付けて保存、
// 書き出しボタン、言語切替、設定・情報ダイアログを担う。
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { IconExport, IconGlobe, IconInfo, IconNew, IconOpen, IconSave, IconSettings } from "../common/icons";
import type { SupportedLanguage } from "../../i18n";
import { changeLanguage, SUPPORTED_LANGUAGES } from "../../i18n";
import { loadProject as ipcLoadProject, saveProject as ipcSaveProject } from "../../lib/ipc";
import { log } from "../../lib/logger";
import { clearHistory, useProjectStore } from "../../stores/projectStore";
import { useUIStore } from "../../stores/uiStore";
import type { Project } from "../../types/model";
import { AboutDialog } from "../dialogs/AboutDialog";
import { SettingsDialog } from "../dialogs/SettingsDialog";

const PROJECT_FILTER_EXT = ["rvep"];

function langLabelKey(lang: string): string {
  return `lang.${lang.replace("-", "")}`;
}

/** 未保存の変更があれば ask() で破棄確認する。続行してよい場合のみ true。 */
async function confirmDiscardIfDirty(t: (key: string) => string): Promise<boolean> {
  if (!useUIStore.getState().dirty) return true;
  return ask(t("header.confirmDiscardMessage"), {
    title: t("header.confirmDiscardTitle"),
    kind: "warning",
  });
}

function resetUiForFreshProject(path: string | null): void {
  useUIStore.getState().setSelectedClipIds([]);
  useUIStore.getState().setSelectedAssetId(null);
  useUIStore.getState().setPlayhead(0);
  useUIStore.getState().setPlaying(false);
  useUIStore.getState().setProjectPath(path);
  useUIStore.getState().setDirty(false);
  clearHistory();
}

export function Header(): JSX.Element {
  const { t, i18n } = useTranslation();
  const projectName = useProjectStore((s) => s.project.name);
  const dirty = useUIStore((s) => s.dirty);
  const projectPath = useUIStore((s) => s.projectPath);
  const settingsOpen = useUIStore((s) => s.settingsDialogOpen);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(projectName);
  const [aboutOpen, setAboutOpen] = useState(false);

  function startEditName(): void {
    setNameDraft(projectName);
    setEditingName(true);
  }

  function commitName(): void {
    setEditingName(false);
    const trimmed = nameDraft.trim();
    if (trimmed.length === 0 || trimmed === projectName) return;
    useProjectStore.getState().setProjectName(trimmed);
    log.info("ui", `プロジェクト名変更: ${trimmed}`);
  }

  async function handleNew(): Promise<void> {
    const ok = await confirmDiscardIfDirty(t);
    if (!ok) return;
    useProjectStore.getState().newProject();
    resetUiForFreshProject(null);
    log.info("ui", "新規プロジェクト作成");
  }

  async function handleOpen(): Promise<void> {
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

  async function handleSaveAs(): Promise<void> {
    try {
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

  async function handleSave(): Promise<void> {
    if (!projectPath) {
      await handleSaveAs();
      return;
    }
    try {
      await writeProjectTo(projectPath);
    } catch (err) {
      log.error("ui", `プロジェクトの保存に失敗しました: ${String(err)}`);
      await message(t("header.saveFailed"), { title: t("app.name"), kind: "error" });
    }
  }

  function handleExport(): void {
    useUIStore.getState().setExportDialogOpen(true);
    log.info("ui", "書き出しダイアログを開く");
  }

  function handleLanguageChange(e: ChangeEvent<HTMLSelectElement>): void {
    void changeLanguage(e.target.value as SupportedLanguage);
  }

  return (
    <header className="app-header">
      <div className="row app-header-left">
        <span className="app-header-name">{t("app.name")}</span>
        {editingName ? (
          <input
            className="app-header-rename-input"
            autoFocus
            value={nameDraft}
            aria-label={t("header.renameLabel")}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === "Enter") commitName();
              else if (e.key === "Escape") setEditingName(false);
            }}
          />
        ) : (
          <span className="app-header-project-name" onClick={startEditName} title={t("header.renameLabel")}>
            {projectName}
            {dirty && <span className="app-header-dirty">●</span>}
          </span>
        )}
      </div>

      <div className="row app-header-actions">
        <button className="btn" onClick={() => void handleNew()} title={t("header.new")}>
          <IconNew size={14} />
          {t("header.new")}
        </button>
        <button className="btn" onClick={() => void handleOpen()} title={t("header.open")}>
          <IconOpen size={14} />
          {t("header.open")}
        </button>
        <button className="btn" onClick={() => void handleSave()} title={t("header.save")}>
          <IconSave size={14} />
          {t("header.save")}
        </button>
        <button className="btn" onClick={() => void handleSaveAs()} title={t("header.saveAs")}>
          {t("header.saveAs")}
        </button>
      </div>

      <div className="row app-header-right">
        <button className="btn btn-accent" onClick={handleExport} title={t("header.export")}>
          <IconExport size={14} />
          {t("header.export")}
        </button>

        <label className="row app-header-lang">
          <IconGlobe size={14} />
          <select value={i18n.language} onChange={handleLanguageChange} aria-label={t("header.language")}>
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {t(langLabelKey(lang))}
              </option>
            ))}
          </select>
        </label>

        <button
          className="btn btn-icon"
          title={t("header.settings")}
          onClick={() => useUIStore.getState().setSettingsDialogOpen(true)}
        >
          <IconSettings size={16} />
        </button>
        <button className="btn btn-icon" title={t("header.about")} onClick={() => setAboutOpen(true)}>
          <IconInfo size={16} />
        </button>
      </div>

      {settingsOpen && <SettingsDialog onClose={() => useUIStore.getState().setSettingsDialogOpen(false)} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </header>
  );
}
