// 情報ダイアログ(DESIGN.md §9)。
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { log } from "../../lib/logger";

export function AboutDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { t } = useTranslation();
  const [version, setVersion] = useState("0.1.0");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch((err: unknown) => {
        log.error("ui", `アプリバージョンの取得に失敗しました: ${String(err)}`);
      });
  }, []);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog-title">{t("aboutDialog.title")}</h2>
        <p>
          {t("aboutDialog.version")}: {version}
        </p>
        <p className="text-sub">{t("aboutDialog.description")}</p>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
