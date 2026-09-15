/**
 * UI preferences (theme + language).
 *
 * Defaults follow the environment — theme from `prefers-color-scheme`,
 * language from the browser locale — and any explicit choice is persisted to
 * localStorage under a single key. The same detection is mirrored in an
 * inline script in web/index.html so the correct theme applies before first
 * paint (no flash of the wrong theme).
 */

import type { Lang } from "./i18n.ts";

export type Theme = "dark" | "light";

export interface Prefs {
  theme: Theme;
  lang: Lang;
}

export const PREFS_KEY = "llm-cockpit.prefs.v1";

const isTheme = (v: unknown): v is Theme => v === "dark" || v === "light";
const isLang = (v: unknown): v is Lang => v === "en" || v === "zh";

function stored(): Partial<Prefs> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw === null) return {};
    const p = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Prefs> = {};
    if (isTheme(p.theme)) out.theme = p.theme;
    if (isLang(p.lang)) out.lang = p.lang;
    return out;
  } catch {
    return {};
  }
}

function detectTheme(): Theme {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
  } catch {
    /* fall through */
  }
  return "dark";
}

function detectLang(): Lang {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.language === "string") {
      return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
    }
  } catch {
    /* fall through */
  }
  return "en";
}

export function readPrefs(): Prefs {
  const s = stored();
  return { theme: s.theme ?? detectTheme(), lang: s.lang ?? detectLang() };
}

export function savePrefs(p: Prefs): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* best effort only */
  }
}
