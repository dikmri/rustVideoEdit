// i18next 初期化(DESIGN.md §10)。
// 初期言語: settings.json → navigator.language → en。切替時は settings.json へ永続化する。
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { readSettings, writeSettings } from "../lib/ipc";
import { log } from "../lib/logger";

import ja from "./locales/ja.json";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import ko from "./locales/ko.json";
import de from "./locales/de.json";
import fr from "./locales/fr.json";
import es from "./locales/es.json";

export const SUPPORTED_LANGUAGES = ["ja", "en", "zh-CN", "ko", "de", "fr", "es"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const resources = {
  ja: { translation: ja },
  en: { translation: en },
  "zh-CN": { translation: zhCN },
  ko: { translation: ko },
  de: { translation: de },
  fr: { translation: fr },
  es: { translation: es },
};

function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** navigator.language(例: "ja-JP", "zh-CN", "en-US")から対応言語を推定する。 */
function detectFromNavigator(): SupportedLanguage {
  const nav = typeof navigator !== "undefined" && navigator.language ? navigator.language : "en";
  if (nav.toLowerCase().startsWith("zh")) return "zh-CN";
  const primary = nav.split("-")[0]?.toLowerCase() ?? "en";
  return isSupportedLanguage(primary) ? primary : "en";
}

async function readSettingsObject(): Promise<Record<string, unknown>> {
  try {
    const raw = await readSettings();
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    log.error("i18n", `settings.json の読込に失敗しました: ${String(err)}`);
    return {};
  }
}

async function writeSettingsObject(obj: Record<string, unknown>): Promise<void> {
  try {
    await writeSettings(JSON.stringify(obj, null, 2));
  } catch (err) {
    log.error("i18n", `settings.json の書込に失敗しました: ${String(err)}`);
  }
}

/** settings.json → navigator.language → en の優先順で初期言語を決定し、i18next を初期化する。 */
export async function initI18n(): Promise<void> {
  const settings = await readSettingsObject();
  const stored = settings["language"];
  const initialLanguage = isSupportedLanguage(stored) ? stored : detectFromNavigator();

  await i18n.use(initReactI18next).init({
    resources,
    lng: initialLanguage,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
}

/** 言語を即時切替し、settings.json へ永続化する(DESIGN §10)。 */
export async function changeLanguage(lang: SupportedLanguage): Promise<void> {
  await i18n.changeLanguage(lang);
  const settings = await readSettingsObject();
  settings["language"] = lang;
  await writeSettingsObject(settings);
  log.info("ui", `言語切替: ${lang}`);
}

export default i18n;
