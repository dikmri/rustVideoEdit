// 設定ダイアログ(DESIGN.md §9, §10, §13.1, §13.4)。言語・テーマ・書き出し完了音の設定。
import type { ChangeEvent } from "react";
import { useTranslation } from "react-i18next";

import type { SupportedLanguage } from "../../i18n";
import { changeLanguage, SUPPORTED_LANGUAGES } from "../../i18n";
import { changeSoundEnabled, changeTheme } from "../../lib/appSettings";
import { playSuccessChime } from "../../lib/chime";
import { log } from "../../lib/logger";
import type { ThemePreference } from "../../stores/uiStore";
import { useUIStore } from "../../stores/uiStore";

function langLabelKey(lang: string): string {
  return `lang.${lang.replace("-", "")}`;
}

const THEME_OPTIONS: Array<{ value: ThemePreference; labelKey: string }> = [
  { value: "system", labelKey: "settingsDialog.themeSystem" },
  { value: "light", labelKey: "settingsDialog.themeLight" },
  { value: "dark", labelKey: "settingsDialog.themeDark" },
];

export function SettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { t, i18n } = useTranslation();
  const theme = useUIStore((s) => s.theme);
  const soundEnabled = useUIStore((s) => s.soundEnabled);

  function handleLanguageChange(e: ChangeEvent<HTMLSelectElement>): void {
    void changeLanguage(e.target.value as SupportedLanguage);
  }

  function handleThemeChange(e: ChangeEvent<HTMLSelectElement>): void {
    void changeTheme(e.target.value as ThemePreference);
  }

  function handleSoundEnabledChange(e: ChangeEvent<HTMLInputElement>): void {
    void changeSoundEnabled(e.target.checked);
  }

  function handleSoundPreview(): void {
    // 試聴は明示的なユーザー操作のため soundEnabled に関わらず再生する。
    playSuccessChime();
    log.info("ui", "書き出し完了音を試聴");
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog-title">{t("settingsDialog.title")}</h2>
        <div className="col" style={{ gap: 8 }}>
          <div className="properties-row">
            <label>{t("settingsDialog.language")}</label>
            <select value={i18n.language} onChange={handleLanguageChange}>
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {t(langLabelKey(lang))}
                </option>
              ))}
            </select>
          </div>
          <div className="properties-row">
            <label>{t("settingsDialog.theme")}</label>
            <select value={theme} onChange={handleThemeChange}>
              {THEME_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </option>
              ))}
            </select>
          </div>
          <div className="properties-row">
            <label>{t("settingsDialog.soundEnabled")}</label>
            <input type="checkbox" checked={soundEnabled} onChange={handleSoundEnabledChange} />
            <button className="btn" onClick={handleSoundPreview}>
              {t("settingsDialog.soundPreview")}
            </button>
          </div>
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
