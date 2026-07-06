// アプリ設定(テーマ §13.1 / 完了音 §13.4)の読込・適用・永続化。
// settings.json の読み書きは i18n/index.ts と同じ read_settings / write_settings パターンを踏襲する。
import { readSettings, writeSettings } from "./ipc";
import { log } from "./logger";
import type { ThemePreference } from "../stores/uiStore";
import { useUIStore } from "../stores/uiStore";

const THEME_VALUES: readonly ThemePreference[] = ["system", "light", "dark"];

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_VALUES as readonly string[]).includes(value);
}

async function readSettingsObject(): Promise<Record<string, unknown>> {
  try {
    const raw = await readSettings();
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    log.error("settings", `settings.json の読込に失敗しました: ${String(err)}`);
    return {};
  }
}

/** settings.json を読み込み、patch をマージして書き戻す(他キーは保持)。 */
async function updateSettings(patch: Record<string, unknown>): Promise<void> {
  try {
    const settings = await readSettingsObject();
    Object.assign(settings, patch);
    await writeSettings(JSON.stringify(settings, null, 2));
  } catch (err) {
    log.error("settings", `settings.json の書込に失敗しました: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// テーマ(§13.1)
// ---------------------------------------------------------------------------

/** 'system' 選択時に購読している matchMedia とそのリスナー(重複購読・リーク防止)。 */
let systemMedia: MediaQueryList | null = null;
let systemListener: ((e: MediaQueryListEvent) => void) | null = null;

function applyResolvedTheme(dark: boolean): void {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

function unsubscribeSystemTheme(): void {
  if (systemMedia && systemListener) {
    systemMedia.removeEventListener("change", systemListener);
  }
  systemMedia = null;
  systemListener = null;
}

/**
 * テーマ設定を documentElement.dataset.theme へ適用する。
 * 'system' の場合は matchMedia('(prefers-color-scheme: dark)') を購読して変化に即時追従する。
 * 再呼び出し時は必ず既存の購読を解除してから登録し直す(リスナーリーク防止)。
 */
export function applyThemePreference(pref: ThemePreference): void {
  unsubscribeSystemTheme();
  if (pref === "system") {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (e: MediaQueryListEvent): void => {
      applyResolvedTheme(e.matches);
      log.info("ui", `システムテーマ変化に追従: ${e.matches ? "dark" : "light"}`);
    };
    media.addEventListener("change", listener);
    systemMedia = media;
    systemListener = listener;
    applyResolvedTheme(media.matches);
  } else {
    applyResolvedTheme(pref === "dark");
  }
}

/** テーマを切り替え、適用し、settings.json へ永続化する(SettingsDialog から呼ぶ)。 */
export async function changeTheme(pref: ThemePreference): Promise<void> {
  useUIStore.getState().setTheme(pref);
  applyThemePreference(pref);
  log.info("ui", `テーマ切替: ${pref}`);
  await updateSettings({ theme: pref });
}

// ---------------------------------------------------------------------------
// 完了音(§13.4)
// ---------------------------------------------------------------------------

/** 完了音の有効/無効を切り替え、settings.json へ永続化する(SettingsDialog から呼ぶ)。 */
export async function changeSoundEnabled(enabled: boolean): Promise<void> {
  useUIStore.getState().setSoundEnabled(enabled);
  log.info("ui", `書き出し完了音設定: ${enabled ? "on" : "off"}`);
  await updateSettings({ soundEnabled: enabled });
}

// ---------------------------------------------------------------------------
// 起動時初期化
// ---------------------------------------------------------------------------

/**
 * settings.json からテーマ('system'|'light'|'dark'、既定 'system')と
 * soundEnabled(既定 true)を読み込み、uiStore とドキュメントへ反映する。
 * main.tsx が初回レンダリング前に 1 回呼ぶ。
 */
export async function initAppSettings(): Promise<void> {
  const settings = await readSettingsObject();
  const theme = isThemePreference(settings["theme"]) ? settings["theme"] : "system";
  const soundEnabled = typeof settings["soundEnabled"] === "boolean" ? settings["soundEnabled"] : true;
  useUIStore.getState().setTheme(theme);
  useUIStore.getState().setSoundEnabled(soundEnabled);
  applyThemePreference(theme);
  log.info("ui", `設定初期化: theme=${theme} soundEnabled=${soundEnabled}`);
}
