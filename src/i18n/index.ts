import { useSyncExternalStore } from "react";
import { preferences } from "../desktop";
import zhCN from "./zh-CN.json";

export type Locale = "en" | "zh-CN";
export const LANGUAGE_KEY = "sparkdash-language";
const messages: Readonly<Record<string, string>> = zhCN;
const listeners = new Set<() => void>();
let locale: Locale = preferences.getItem(LANGUAGE_KEY) === "zh-CN" ? "zh-CN" : "en";

function applyLocale(value: string | null) {
  const next = value === "zh-CN" ? "zh-CN" : "en";
  document.documentElement.lang = next;
  if (next === locale) return;
  locale = next;
  for (const listener of listeners) listener();
}

document.documentElement.lang = locale;
window.sparkDesktop?.onPreferenceChange?.((key, value) => {
  if (key === LANGUAGE_KEY) applyLocale(value);
});
window.addEventListener("storage", (event) => {
  if (event.key === LANGUAGE_KEY || event.key === null) applyLocale(preferences.getItem(LANGUAGE_KEY));
});

export function setLocale(value: Locale) {
  // Persist first: a failed write must not leave the menu and page out of sync.
  preferences.setItem(LANGUAGE_KEY, value);
  applyLocale(value);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Subscribe each translated component without remounting forms or telemetry. */
export function useLocale() {
  return useSyncExternalStore(subscribe, () => locale);
}

/** English source messages are also the fallback for unknown server diagnostics. */
export function translate(message: string, values: readonly (string | number | null | undefined)[] = []): string {
  const key = message.trim();
  const translated = locale === "zh-CN" && Object.hasOwn(messages, key)
    ? message.slice(0, message.indexOf(key)) + messages[key] + message.slice(message.indexOf(key) + key.length)
    : message;
  return translated.replace(/\{(\d+)\}/g, (match, index: string) => String(values[Number(index)] ?? match));
}
