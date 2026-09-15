import { afterEach, expect, test } from "bun:test";
import { PREFS_KEY, readPrefs, savePrefs } from "../web/prefs.ts";

function stubEnv(opts: {
  light?: boolean;
  language?: string;
  stored?: string | null;
}): Map<string, string> {
  const store = new Map<string, string>();
  if (opts.stored !== undefined && opts.stored !== null) store.set(PREFS_KEY, opts.stored);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string): string | null => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string): void => {
        store.set(k, v);
      },
      removeItem: (k: string): void => {
        store.delete(k);
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      matchMedia: (q: string): { matches: boolean } => ({
        matches: opts.light === true && q.includes("light"),
      }),
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { language: opts.language ?? "en-US" },
  });
  return store;
}

afterEach((): void => {
  delete (globalThis as Record<string, unknown>).localStorage;
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).navigator;
});

test("falls back to system theme and browser language", () => {
  stubEnv({ light: true, language: "zh-CN" });
  expect(readPrefs()).toEqual({ theme: "light", lang: "zh" });
  stubEnv({ light: false, language: "en-US" });
  expect(readPrefs()).toEqual({ theme: "dark", lang: "en" });
});

test("stored prefs win over environment", () => {
  stubEnv({
    light: true,
    language: "zh-CN",
    stored: JSON.stringify({ theme: "dark", lang: "en" }),
  });
  expect(readPrefs()).toEqual({ theme: "dark", lang: "en" });
});

test("partial stored prefs fill gaps from environment", () => {
  stubEnv({ light: true, language: "fr-FR", stored: JSON.stringify({ lang: "zh" }) });
  expect(readPrefs()).toEqual({ theme: "light", lang: "zh" });
});

test("invalid stored values are ignored", () => {
  stubEnv({ light: false, stored: JSON.stringify({ theme: "neon", lang: "de" }) });
  expect(readPrefs()).toEqual({ theme: "dark", lang: "en" });
  stubEnv({ light: false, stored: "{not json" });
  expect(readPrefs()).toEqual({ theme: "dark", lang: "en" });
});

test("savePrefs round-trips through storage", () => {
  const store = stubEnv({ light: false });
  savePrefs({ theme: "light", lang: "zh" });
  expect(JSON.parse(store.get(PREFS_KEY) as string)).toEqual({ theme: "light", lang: "zh" });
});
