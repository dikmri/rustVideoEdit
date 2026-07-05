// フロントエンドの共通ロガー。IPC 経由で Rust 側の同一ログファイルへ書き込む(DESIGN.md §6)。
import { logEvent } from "./ipc";

type LogLevel = "info" | "warn" | "error";

function send(level: LogLevel, target: string, message: string): void {
  // IPC 呼び出し失敗時は console のみに留める(無限ループ防止のため logger.error を再帰呼び出ししない)。
  logEvent(level, target, message).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[logger] log_event 送信に失敗しました", err);
  });
}

export const log = {
  info(target: string, message: string): void {
    // eslint-disable-next-line no-console
    console.info(`[${target}] ${message}`);
    send("info", target, message);
  },
  warn(target: string, message: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[${target}] ${message}`);
    send("warn", target, message);
  },
  error(target: string, message: string): void {
    // eslint-disable-next-line no-console
    console.error(`[${target}] ${message}`);
    send("error", target, message);
  },
};

let installed = false;

export function installGlobalErrorLogging(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (event: ErrorEvent) => {
    log.error(
      "window",
      `onerror: ${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
    );
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason =
      event.reason instanceof Error
        ? `${event.reason.name}: ${event.reason.message}`
        : String(event.reason);
    log.error("window", `unhandledrejection: ${reason}`);
  });
}
