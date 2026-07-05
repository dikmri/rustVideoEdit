import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalErrorLogging, log } from "./lib/logger";
import { initI18n } from "./i18n";
import "./styles/tokens.css";
import "./styles/base.css";

installGlobalErrorLogging();

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

initI18n()
  .catch((err) => {
    log.error("i18n", `初期化に失敗しました: ${String(err)}`);
  })
  .finally(() => {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
