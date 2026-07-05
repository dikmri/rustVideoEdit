// 更新バナー(DESIGN.md §11)。App.tsx が起動 3 秒後に check() した結果を渡す。
import { relaunch } from "@tauri-apps/plugin-process";
import type { Update } from "@tauri-apps/plugin-updater";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { log } from "../../lib/logger";

export function UpdateBanner({ update }: { update: Update }): JSX.Element {
  const { t } = useTranslation();
  const [updating, setUpdating] = useState(false);

  async function handleUpdate(): Promise<void> {
    setUpdating(true);
    log.info("ui", `アップデート開始: v${update.version}`);
    try {
      await update.downloadAndInstall();
      log.info("ui", "アップデートの適用が完了しました。再起動します。");
      await relaunch();
    } catch (err) {
      log.error("ui", `アップデートに失敗しました: ${String(err)}`);
      setUpdating(false);
    }
  }

  return (
    <div className="update-banner">
      <span>{t("updateBanner.available", { version: update.version })}</span>
      <button className="btn btn-accent" disabled={updating} onClick={() => void handleUpdate()}>
        {updating ? t("updateBanner.updating") : t("updateBanner.update")}
      </button>
    </div>
  );
}
