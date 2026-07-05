// 設定ダイアログ(DESIGN.md §9, §10)。現状は言語切替のみ。
import type { ChangeEvent } from "react";
import { useTranslation } from "react-i18next";

import type { SupportedLanguage } from "../../i18n";
import { changeLanguage, SUPPORTED_LANGUAGES } from "../../i18n";

function langLabelKey(lang: string): string {
  return `lang.${lang.replace("-", "")}`;
}

export function SettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { t, i18n } = useTranslation();

  function handleChange(e: ChangeEvent<HTMLSelectElement>): void {
    void changeLanguage(e.target.value as SupportedLanguage);
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog-title">{t("settingsDialog.title")}</h2>
        <div className="properties-row">
          <label>{t("settingsDialog.language")}</label>
          <select value={i18n.language} onChange={handleChange}>
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {t(langLabelKey(lang))}
              </option>
            ))}
          </select>
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
