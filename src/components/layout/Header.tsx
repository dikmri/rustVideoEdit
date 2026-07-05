// ヘッダー(DESIGN.md §9)。プロジェクト名インライン編集、新規/開く/保存/名前を付けて保存、
// 書き出しボタン、言語切替、設定・情報ダイアログを担う。
// 新規/開く/保存のロジックは lib/projectActions.ts に集約し、shortcuts.ts の Ctrl+N/O/S と共有する。
import { useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { IconExport, IconGlobe, IconInfo, IconNew, IconOpen, IconSave, IconSettings } from "../common/icons";
import type { SupportedLanguage } from "../../i18n";
import { changeLanguage, SUPPORTED_LANGUAGES } from "../../i18n";
import { log } from "../../lib/logger";
import { newProject, openProject, saveProject, saveProjectAs } from "../../lib/projectActions";
import { useProjectStore } from "../../stores/projectStore";
import { useUIStore } from "../../stores/uiStore";
import { AboutDialog } from "../dialogs/AboutDialog";
import { SettingsDialog } from "../dialogs/SettingsDialog";

function langLabelKey(lang: string): string {
  return `lang.${lang.replace("-", "")}`;
}

export function Header(): JSX.Element {
  const { t, i18n } = useTranslation();
  const projectName = useProjectStore((s) => s.project.name);
  const dirty = useUIStore((s) => s.dirty);
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
    await newProject(t);
  }

  async function handleOpen(): Promise<void> {
    await openProject(t);
  }

  async function handleSaveAs(): Promise<void> {
    await saveProjectAs(t);
  }

  async function handleSave(): Promise<void> {
    await saveProject(t);
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
