import * as React from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "./chat.tsx";
import { type Lang, t } from "./i18n.ts";
import { MonitorView } from "./monitor.tsx";
import { readPrefs, savePrefs, type Theme } from "./prefs.ts";
import { HeaderToggles, UICtx, type UIState } from "./shared.tsx";
import type { ChartPoint, GpuSeries, GpuState, Snapshot, Target } from "./types.ts";

function App() {
  const [targets, setTargets] = React.useState<Target[]>([]);
  const [sel, setSel] = React.useState<string | null>(null);
  const [snap, setSnap] = React.useState<Snapshot | null>(null);
  const [history, setHistory] = React.useState<ChartPoint[]>([]);
  const [gpu, setGpu] = React.useState<GpuState | null>(null);
  const [gpuHist, setGpuHist] = React.useState<Record<number, GpuSeries>>({});
  const [err, setErr] = React.useState<string | null>(null);
  const [booted, setBooted] = React.useState(false);
  const [view, setView] = React.useState<"monitor" | "chat">("monitor");
  const [theme, setTheme] = React.useState<Theme>((): Theme => readPrefs().theme);
  const [lang, setLang] = React.useState<Lang>((): Lang => readPrefs().lang);

  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.lang = lang;
    savePrefs({ theme, lang });
  }, [theme, lang]);

  const ui = React.useMemo<UIState>(() => ({ theme, lang, setTheme, setLang }), [theme, lang]);

  React.useEffect(() => {
    fetch("/api/targets")
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{ targets: Target[] }>)
          : Promise.reject(new Error("bad response")),
      )
      .then((d) => {
        setTargets(d.targets);
        const first = d.targets[0];
        if (first !== undefined) setSel(first.id);
      })
      .catch(() => setErr("api-down"))
      .finally(() => setBooted(true));
  }, []);

  React.useEffect(() => {
    if (sel === null) return;
    let stop = false;
    const tick = async (): Promise<void> => {
      try {
        const [s, h, gp] = await Promise.all([
          fetch(`/api/snapshot?target=${encodeURIComponent(sel)}`).then(
            (r) => r.json() as Promise<{ snapshot: Snapshot | null }>,
          ),
          fetch(`/api/history?target=${encodeURIComponent(sel)}&sec=900&compact=1`).then(
            (r) => r.json() as Promise<{ points: ChartPoint[] }>,
          ),
          fetch("/api/gpu")
            .then((r) => (r.ok ? (r.json() as Promise<GpuState>) : null))
            .catch(() => null),
        ]);
        if (stop) return;
        setSnap(s.snapshot);
        setHistory(h.points);
        if (gp !== null) {
          setGpu(gp);
          if (gp.available) {
            setGpuHist((prev) => {
              const out: Record<number, GpuSeries> = { ...prev };
              for (const g of gp.gpus) {
                const memPct =
                  g.memUsedMb !== null && g.memTotalMb !== null && g.memTotalMb > 0
                    ? (g.memUsedMb / g.memTotalMb) * 100
                    : null;
                const series = out[g.index] ?? { util: [], mem: [] };
                out[g.index] = {
                  util: [...series.util, g.utilPct].slice(-450),
                  mem: [...series.mem, memPct].slice(-450),
                };
              }
              return out;
            });
          }
        }
        setErr(null);
      } catch {
        if (!stop) setErr("api-down");
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [sel]);

  const target = targets.find((t) => t.id === sel) ?? null;
  const badgeCls =
    target === null || target.status === "pending"
      ? "pend"
      : target.status === "online"
        ? "ok"
        : "off";
  const badgeTxt =
    target === null
      ? t(lang, "target.none")
      : target.status === "online"
        ? t(lang, "target.online")
        : target.status === "offline"
          ? t(lang, "target.offline")
          : t(lang, "target.pending");

  if (booted && targets.length === 0) {
    return (
      <UICtx.Provider value={ui}>
        <div className="wrap">
          <header className="hdr">
            <div className="brand">
              <span className="logo">◍</span>
              <span className="wordmark">
                LLM <em>Cockpit</em>
              </span>
            </div>
            <div className="hdr-right">
              <HeaderToggles />
            </div>
          </header>
          <div className="banner">{t(lang, "banner.noTargets")}</div>
        </div>
      </UICtx.Provider>
    );
  }

  return (
    <UICtx.Provider value={ui}>
      <div className="wrap">
        <header className="hdr">
          <div className="brand">
            <span className="logo">◍</span>
            <span className="wordmark">
              LLM <em>Cockpit</em>
            </span>
            <nav className="nav">
              <button
                type="button"
                className={view === "monitor" ? "on" : undefined}
                onClick={() => setView("monitor")}
              >
                {t(lang, "nav.monitor")}
              </button>
              <button
                type="button"
                className={view === "chat" ? "on" : undefined}
                onClick={() => setView("chat")}
              >
                {t(lang, "nav.chat")}
              </button>
            </nav>
          </div>
          <div className="hdr-right">
            {targets.length > 1 ? (
              <select className="sel" value={sel ?? ""} onChange={(e) => setSel(e.target.value)}>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id} · {t.url}
                  </option>
                ))}
              </select>
            ) : null}
            <span className={`badge ${badgeCls}`}>{badgeTxt}</span>
            {snap !== null ? (
              <span className="meta">
                {snap.engine.model ?? target?.model ?? "—"}
                {snap.engine.version !== null ? ` · v${snap.engine.version}` : ""} ·{" "}
                {snap.engine.adapter} · {snap.engine.rttMs}ms
              </span>
            ) : null}
            <HeaderToggles />
          </div>
        </header>

        {err !== null ? (
          <div className="banner">{err === "api-down" ? t(lang, "banner.apiDown") : err}</div>
        ) : null}
        {snap !== null && !snap.engine.healthy ? (
          <div className="banner">{t(lang, "banner.engineDown")}</div>
        ) : null}

        <div className={`view${view === "monitor" ? "" : " hidden"}`}>
          <MonitorView snap={snap} history={history} gpu={gpu} gpuHist={gpuHist} target={target} />
        </div>
        <div className={`view${view === "chat" ? "" : " hidden"}`}>
          <Chat />
        </div>
      </div>
    </UICtx.Provider>
  );
}

const rootEl = document.getElementById("root");
if (rootEl !== null) createRoot(rootEl).render(<App />);
