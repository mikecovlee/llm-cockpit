import * as React from "react";
import { type Lang, t } from "./i18n.ts";
import type { Theme } from "./prefs.ts";

const fmtNum = (v: number | null, digits = 1): string =>
  v === null || Number.isNaN(v)
    ? "—"
    : v.toLocaleString("en-US", { maximumFractionDigits: digits });

const fmtPct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

const fmtTok = (v: number | null): string => {
  if (v === null) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
};

const fmtTime = (ts: number, lang: Lang): string =>
  new Date(ts).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-GB", { hour12: false });

const uid = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export { fmtNum, fmtPct, fmtTime, fmtTok, uid };

/* ---------- theme + language (UI prefs) ---------- */

export interface UIState {
  theme: Theme;
  lang: Lang;
  setTheme: (v: Theme) => void;
  setLang: (v: Lang) => void;
}

export const UICtx = React.createContext<UIState>({
  theme: "dark",
  lang: "en",
  setTheme: (): void => undefined,
  setLang: (): void => undefined,
});

export const useUI = (): UIState => React.useContext(UICtx);

function SunIcon(): React.ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4" />
    </svg>
  );
}

function MoonIcon(): React.ReactElement {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

export function HeaderToggles(): React.ReactElement {
  const ui = useUI();
  return (
    <>
      <button
        type="button"
        className="icon-btn"
        title={ui.lang === "en" ? t(ui.lang, "hdr.toZh") : t(ui.lang, "hdr.toEn")}
        onClick={() => ui.setLang(ui.lang === "en" ? "zh" : "en")}
      >
        {ui.lang === "en" ? "中" : "EN"}
      </button>
      <button
        type="button"
        className="icon-btn"
        title={ui.theme === "dark" ? t(ui.lang, "hdr.toLight") : t(ui.lang, "hdr.toDark")}
        onClick={() => ui.setTheme(ui.theme === "dark" ? "light" : "dark")}
      >
        {ui.theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>
    </>
  );
}

/* ---------- layout primitives ---------- */

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      {children}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub !== undefined ? <div className="stat-label">{sub}</div> : null}
    </div>
  );
}

export function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <span title={label}>{label}</span>
      <b title={value}>{value}</b>
    </div>
  );
}
