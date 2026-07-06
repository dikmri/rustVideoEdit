import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalErrorLogging, log } from "./lib/logger";
import { initAppSettings } from "./lib/appSettings";
import { initI18n } from "./i18n";
import "./styles/tokens.css";
import "./styles/base.css";

installGlobalErrorLogging();

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// i18n とテーマ/完了音設定を初期化してから初回レンダリングする(失敗してもログのみで続行)。
Promise.all([
  initI18n().catch((err) => {
    log.error("i18n", `初期化に失敗しました: ${String(err)}`);
  }),
  initAppSettings().catch((err) => {
    log.error("ui", `設定の初期化に失敗しました: ${String(err)}`);
  }),
]).finally(() => {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
