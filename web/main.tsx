import DOMPurify from "dompurify";
import * as echarts from "echarts";
import hljs from "highlight.js";
import { marked } from "marked";
import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  buildPayload,
  type ChatParams,
  type ChatUsage,
  copyText,
  defaultMetrics,
  defaultParams,
  formatUsage,
  loadSession,
  type MetricToggles,
  parseUsage,
  type SessionMsg,
  safeLocalStorage,
  saveSession,
  type WireMessage,
} from "./chatPayload.ts";
import { type Lang, t } from "./i18n.ts";
import { readPrefs, savePrefs, type Theme } from "./prefs.ts";

/* ---------- canonical model types (mirror of src/core/model.ts) ---------- */

interface HistBuckets {
  buckets: { upper: number; count: number }[];
  sum: number;
  count: number;
}

interface Snapshot {
  ts: number;
  engine: {
    adapter: string;
    model: string | null;
    version: string | null;
    healthy: boolean;
    rttMs: number;
  };
  requests: {
    running: number | null;
    queued: number | null;
    swapped: number | null;
    paused: number | null;
  };
  throughput: {
    generationTps: number | null;
    prefillTps: number | null;
    requestsPerSec: number | null;
    prefillEffectiveTotal: number | null;
    prefillEffectiveTps: number | null;
  };
  tokens: {
    promptTotal: number | null;
    generationTotal: number | null;
    cachedTotal: number | null;
  };
  counts: { requestsCompletedTotal: number | null };
  cache: {
    kvUsagePct: number | null;
    kvUsedTokens: number | null;
    kvTotalTokens: number | null;
    hitRate: number | null;
    prefixHitsTotal: number | null;
    prefixQueriesTotal: number | null;
    cumulativeHitRate: number | null;
    hostUsedTokens: number | null;
    hostTotalTokens: number | null;
    kvAvailableTokens: number | null;
    deviceHitTotal: number | null;
    hostHitTotal: number | null;
    storageHitTotal: number | null;
    deviceHitTps: number | null;
    hostHitTps: number | null;
    storageHitTps: number | null;
  };
  latency: {
    ttft: HistBuckets | null;
    tpot: HistBuckets | null;
    e2e: HistBuckets | null;
    queueWait: HistBuckets | null;
  };
  faults: { retractedTotal: number | null; preemptedTotal: number | null };
  extras: Record<string, number | null>;
  capabilities: Record<string, boolean>;
}

interface GpuRow {
  index: number;
  name: string;
  utilPct: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  tempC: number | null;
  powerW: number | null;
  powerLimitW: number | null;
}

interface GpuState {
  available: boolean;
  gpus: GpuRow[];
}

interface Target {
  id: string;
  url: string;
  adapter: string;
  status: "pending" | "online" | "offline";
  model: string | null;
  version: string | null;
}

/* ---------- formatting + quantile helpers ---------- */

function quantile(b: { upper: number; count: number }[], total: number, q: number): number | null {
  if (!(total > 0) || !(q > 0 && q <= 1) || b.length === 0) return null;
  const target = q * total;
  let prevCount = 0;
  let prevUpper = 0;
  for (const bucket of b) {
    if (bucket.count >= target) {
      const width = bucket.count - prevCount;
      if (width <= 0) return bucket.upper;
      return prevUpper + (bucket.upper - prevUpper) * ((target - prevCount) / width);
    }
    prevCount = bucket.count;
    prevUpper = bucket.upper;
  }
  const last = b[b.length - 1]!;
  return last.upper;
}

function hq(h: HistBuckets | null): {
  p50: number | null;
  p90: number | null;
  p99: number | null;
  mean: number | null;
} {
  if (h === null || h.count <= 0) return { p50: null, p90: null, p99: null, mean: null };
  return {
    p50: quantile(h.buckets, h.count, 0.5),
    p90: quantile(h.buckets, h.count, 0.9),
    p99: quantile(h.buckets, h.count, 0.99),
    mean: h.sum / h.count,
  };
}

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

/** Wire shape of /api/history?compact=1 — chart scalars only (public API
 * contract mirrored by toChartPoint in src/server.ts). */
interface ChartPoint {
  ts: number;
  requests: {
    running: number | null;
    queued: number | null;
    paused: number | null;
    swapped: number | null;
  };
  throughput: {
    generationTps: number | null;
    prefillTps: number | null;
    prefillEffectiveTps: number | null;
  };
  cache: {
    kvUsagePct: number | null;
    hostUsedTokens: number | null;
    hostTotalTokens: number | null;
  };
  latency: { ttft: { p50: number | null; p90: number | null; p99: number | null } | null };
}

const fmtTime = (ts: number, lang: Lang): string =>
  new Date(ts).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-GB", { hour12: false });

const uid = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/* ---------- theme + language (UI prefs) ---------- */

interface UIState {
  theme: Theme;
  lang: Lang;
  setTheme: (v: Theme) => void;
  setLang: (v: Lang) => void;
}

const UICtx = React.createContext<UIState>({
  theme: "dark",
  lang: "en",
  setTheme: (): void => undefined,
  setLang: (): void => undefined,
});

const useUI = (): UIState => React.useContext(UICtx);

interface ChartPalette {
  axis: string;
  grid: string;
  split: string;
  legend: string;
  blue: string;
  green: string;
  amber: string;
  red: string;
  violet: string;
  orange: string;
  pink: string;
  blueLight: string;
  teal: string;
}

const CHART: Record<Theme, ChartPalette> = {
  dark: {
    axis: "#6e7681",
    grid: "#21262d",
    split: "#1c2128",
    legend: "#8b949e",
    blue: "#38bdf8",
    green: "#34d399",
    amber: "#fbbf24",
    red: "#f87171",
    violet: "#a78bfa",
    orange: "#fb923c",
    pink: "#f472b6",
    blueLight: "#60a5fa",
    teal: "#2dd4bf",
  },
  light: {
    axis: "#57606a",
    grid: "#d0d7de",
    split: "#e6ebf1",
    legend: "#57606a",
    blue: "#0284c7",
    green: "#059669",
    amber: "#d97706",
    red: "#dc2626",
    violet: "#7c3aed",
    orange: "#ea580c",
    pink: "#db2777",
    blueLight: "#2563eb",
    teal: "#0d9488",
  },
};

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

function HeaderToggles(): React.ReactElement {
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

/* ---------- echarts line chart ---------- */

interface Series {
  name: string;
  data: (number | null)[];
  color: string;
}

function LineChart({ series, labels }: { series: Series[]; labels: string[] }) {
  const { theme } = useUI();
  const ref = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<echarts.ECharts | null>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    const onResize = (): void => chart.resize();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    const c = CHART[theme];
    chart.setOption({
      backgroundColor: "transparent",
      grid: { left: 46, right: 26, top: series.length > 1 ? 30 : 18, bottom: 22 },
      tooltip: {
        trigger: "axis",
        appendToBody: true,
        extraCssText: "z-index: 120;",
        valueFormatter: (v: unknown): string =>
          typeof v === "number"
            ? Math.abs(v) >= 1000
              ? v.toLocaleString("en-US", { maximumFractionDigits: 0 })
              : String(Math.round(v * 100) / 100)
            : "—",
      },
      legend:
        series.length > 1
          ? { top: 0, textStyle: { color: c.legend, fontSize: 11 }, itemWidth: 14, itemHeight: 8 }
          : undefined,
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { color: c.axis, fontSize: 10 },
        axisLine: { lineStyle: { color: c.grid } },
        boundaryGap: false,
      },
      yAxis: {
        type: "value",
        axisLabel: { color: c.axis, fontSize: 10 },
        splitLine: { lineStyle: { color: c.split } },
      },
      series: series.map((s) => ({
        name: s.name,
        type: "line" as const,
        data: s.data,
        showSymbol: false,
        connectNulls: true,
        lineStyle: { width: 1.5, color: s.color },
        itemStyle: { color: s.color },
      })),
    });
  }, [series, labels, theme]);

  return <div ref={ref} className="chart" />;
}

/* ---------- layout primitives ---------- */

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      {children}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub !== undefined ? <div className="stat-label">{sub}</div> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <span title={label}>{label}</span>
      <b title={value}>{value}</b>
    </div>
  );
}

/* ---------- chat ---------- */

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  streaming?: boolean;
  images?: { id: string; url: string }[];
  usage?: ChatUsage;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function Bubble({ msg }: { msg: ChatMsg }) {
  const { lang } = useUI();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (el === null || msg.content === "") return;
    el.innerHTML = DOMPurify.sanitize(marked.parse(msg.content, { async: false }) as string);
    for (const c of Array.from(el.querySelectorAll<HTMLElement>("pre code"))) {
      hljs.highlightElement(c);
    }
    for (const pre of Array.from(el.querySelectorAll<HTMLElement>("pre"))) {
      const code = pre.querySelector("code");
      const ctl = document.createElement("div");
      ctl.className = "codectl";
      const langTag = document.createElement("span");
      langTag.textContent = code?.className.match(/language-([\w-]+)/)?.[1] ?? t(lang, "chat.code");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = t(lang, "chat.copy");
      btn.addEventListener("click", () => {
        void copyText(code?.textContent ?? "").then((ok): void => {
          if (ok) {
            btn.textContent = t(lang, "chat.copied");
            setTimeout(() => {
              btn.textContent = t(lang, "chat.copy");
            }, 1500);
          }
        });
      });
      ctl.append(langTag, btn);
      pre.insertBefore(ctl, pre.firstChild);
    }
  }, [msg.content, lang]);
  return (
    <div className={`bubble ${msg.role}`}>
      {msg.role === "user" && msg.images !== undefined && msg.images.length > 0 ? (
        <div className="thumbs">
          {msg.images.map((img) => (
            <img key={img.id} src={img.url} alt={t(lang, "chat.attachment")} className="thumb" />
          ))}
        </div>
      ) : null}
      {msg.thinking !== undefined && msg.thinking !== "" ? (
        <details className="thinking">
          <summary>{t(lang, "chat.thinking")}</summary>
          <pre>{msg.thinking}</pre>
        </details>
      ) : null}
      <div ref={ref} />
      {msg.streaming ? <span className="cursor">▍</span> : null}
    </div>
  );
}

interface ProviderInfo {
  id: string;
  name: string;
  default: boolean;
  thinking: { on: Record<string, unknown> | null; off: Record<string, unknown> | null } | null;
}

interface ProviderGroup {
  info: ProviderInfo;
  models: string[];
  error: string | null;
}

/** option value form: "<providerId>::<modelId>" — provider ids cannot contain
 * ":" (config regex), so the first "::" split is unambiguous. */
const splitSel = (v: string): { pid: string; model: string } | null => {
  const i = v.indexOf("::");
  return i < 0 ? null : { pid: v.slice(0, i), model: v.slice(i + 2) };
};

const chatErrText = (l: Lang, code: string): string =>
  code === "no models"
    ? t(l, "chat.noModels")
    : code === "unreachable"
      ? t(l, "chat.unreachable")
      : code === "api-down"
        ? t(l, "chat.apiDown")
        : code;

const initialSession = loadSession(safeLocalStorage());

const parseNum = (v: string): number | null => {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function Chat() {
  const { lang } = useUI();
  const [sel, setSel] = React.useState<string>(initialSession?.sel ?? "");
  const [groups, setGroups] = React.useState<ProviderGroup[]>([]);
  const [chatErr, setChatErr] = React.useState<string | null>(null);
  const [msgs, setMsgs] = React.useState<ChatMsg[]>(() =>
    (initialSession?.msgs ?? []).map(
      (m): ChatMsg => ({
        id: m.id,
        role: m.role,
        content: m.content,
        thinking: m.thinking,
        images: m.images?.map((u, i) => ({ id: `${m.id}-im${i}`, url: u })),
        usage: m.usage,
      }),
    ),
  );
  const [params, setParams] = React.useState<ChatParams>(initialSession?.params ?? defaultParams());
  const [metrics, setMetrics] = React.useState<MetricToggles>(
    initialSession?.metrics ?? defaultMetrics(),
  );
  const [showParams, setShowParams] = React.useState(false);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const noStreamUsage = React.useRef(new Set<string>());
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [pendingImages, setPendingImages] = React.useState<{ id: string; url: string }[]>([]);
  const [attachError, setAttachError] = React.useState<string | null>(null);

  const addFiles = (files: FileList | null): void => {
    if (files === null || files.length === 0) return;
    setAttachError(null);
    let room = 4 - pendingImages.length;
    for (const file of Array.from(files)) {
      if (room <= 0) {
        setAttachError(t(lang, "chat.tooMany"));
        break;
      }
      room -= 1;
      if (file.size > 8 * 1024 * 1024) {
        setAttachError(t(lang, "chat.tooBig", { name: file.name }));
        continue;
      }
      const reader = new FileReader();
      reader.onload = (): void => {
        if (typeof reader.result !== "string") return;
        const raw = reader.result;
        const img = new Image();
        img.onload = (): void => {
          const maxSide = Math.max(img.naturalWidth, img.naturalHeight);
          let url = raw;
          if (maxSide > 1280 || raw.length > 2 * 1024 * 1024) {
            const scale = Math.min(1, 1280 / Math.max(1, maxSide));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            const ctx = canvas.getContext("2d");
            if (ctx !== null) {
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              url = canvas.toDataURL("image/jpeg", 0.85);
            }
          }
          setPendingImages((prev) => [...prev, { id: uid(), url }].slice(0, 4));
        };
        img.onerror = (): void => {
          setAttachError(t(lang, "chat.decodeErr", { name: file.name }));
        };
        img.src = raw;
      };
      reader.readAsDataURL(file);
    }
  };

  const toContent = (
    text: string,
    images: { id: string; url: string }[],
  ): string | ContentPart[] => {
    if (images.length === 0) return text;
    const parts: ContentPart[] = images.map((p) => ({
      type: "image_url",
      image_url: { url: p.url },
    }));
    if (text !== "") parts.push({ type: "text", text });
    return parts;
  };

  React.useEffect(() => {
    let stop = false;
    void (async (): Promise<void> => {
      try {
        const pr = await fetch("/api/chat/providers");
        const pj = (await pr.json()) as { providers?: ProviderInfo[]; default?: string };
        const infos = Array.isArray(pj.providers) ? pj.providers : [];
        const loaded = await Promise.all(
          infos.map(async (info): Promise<ProviderGroup> => {
            try {
              const r = await fetch(`/api/chat/models?provider=${encodeURIComponent(info.id)}`);
              const d = (await r.json()) as {
                data?: { id: string }[];
                ok?: boolean;
                error?: string;
              };
              const ms = r.ok ? (d.data ?? []).map((m) => m.id) : [];
              return {
                info,
                models: ms,
                error: r.ok ? (ms.length === 0 ? "no models" : null) : (d.error ?? "unreachable"),
              };
            } catch {
              return { info, models: [], error: "unreachable" };
            }
          }),
        );
        if (stop) return;
        setGroups(loaded);
        const def = loaded.find((g) => g.info.id === pj.default) ?? loaded[0];
        const first = def?.models[0];
        const wanted = initialSession?.sel ?? "";
        const wantedValid =
          wanted !== "" &&
          loaded.some((g) => g.models.some((mm) => `${g.info.id}::${mm}` === wanted));
        if (!wantedValid && def !== undefined && first !== undefined) {
          setSel(`${def.info.id}::${first}`);
        }
      } catch {
        if (!stop) setChatErr("api-down");
      }
    })();
    return () => {
      stop = true;
    };
  }, []);

  const stickRef = React.useRef(true);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onScroll = (): void => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && msgs.length > 0 && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const wireFor = (list: ChatMsg[]): WireMessage[] =>
    list.map(
      (m): WireMessage => ({
        role: m.role,
        content: toContent(m.content, m.images !== undefined ? m.images : []),
      }),
    );

  const runStream = async (hist: ChatMsg[], newUser: ChatMsg | null): Promise<void> => {
    const cur = splitSel(sel);
    if (cur === null || cur.model === "") return;
    const assistantId = uid();
    const base = newUser !== null ? [...hist, newUser] : hist;
    setMsgs([...base, { id: assistantId, role: "assistant", content: "", streaming: true }]);
    setInput("");
    setPendingImages([]);
    setAttachError(null);
    setBusy(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    const grp = groups.find((g) => g.info.id === cur.pid);
    const wantUsage = !noStreamUsage.current.has(cur.pid);
    const payload = buildPayload({
      model: cur.model,
      history: wireFor(base),
      params,
      thinking: grp?.info.thinking ?? null,
      includeUsage: wantUsage,
    });
    let acc = "";
    let think = "";
    let usage: Omit<ChatUsage, "tps" | "ttftMs"> | null = null;
    let finalUsage: ChatUsage | undefined;
    const t0 = Date.now();
    let firstDeltaAt: number | null = null;
    const markDelta = (): void => {
      if (firstDeltaAt === null) firstDeltaAt = Date.now();
    };
    const finishUsage = (): void => {
      if (usage === null) return;
      const end = Date.now();
      const tps =
        usage.completion !== null && firstDeltaAt !== null && end > firstDeltaAt
          ? usage.completion / ((end - firstDeltaAt) / 1000)
          : null;
      finalUsage = {
        ...usage,
        tps,
        ttftMs: firstDeltaAt === null ? null : firstDeltaAt - t0,
      };
    };
    try {
      let r = await fetch(`/api/chat/stream?provider=${encodeURIComponent(cur.pid)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
      if (!r.ok && wantUsage) {
        const probe = await r.text().catch(() => "");
        if (/stream_options/i.test(probe)) {
          noStreamUsage.current.add(cur.pid);
          r = await fetch(`/api/chat/stream?provider=${encodeURIComponent(cur.pid)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...payload, stream_options: undefined }),
            signal: ctl.signal,
          });
        } else {
          throw new Error(`HTTP ${r.status}: ${probe.slice(0, 300)}`);
        }
      }
      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`HTTP ${r.status}: ${errText.slice(0, 300)}`);
      }
      if (r.body === null) throw new Error("no response body");
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (line === "" || !line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data) as {
              choices?: { delta?: { content?: string; reasoning_content?: string } }[];
            };
            const u = parseUsage(j);
            if (u !== null) usage = u;
            const delta = j.choices?.[0]?.delta;
            if (typeof delta?.content === "string" && delta.content !== "") {
              acc += delta.content;
              markDelta();
            }
            if (typeof delta?.reasoning_content === "string" && delta.reasoning_content !== "") {
              think += delta.reasoning_content;
              markDelta();
            }
          } catch {
            // skip malformed chunk
          }
        }
        setMsgs((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last !== undefined && last.role === "assistant") {
            next[next.length - 1] = {
              id: last.id,
              role: "assistant",
              content: acc,
              thinking: think === "" ? undefined : think,
              streaming: true,
            };
          }
          return next;
        });
      }
      finishUsage();
    } catch (e) {
      finishUsage();
      if ((e as { name?: string })?.name !== "AbortError") {
        acc =
          acc === ""
            ? `${t(lang, "chat.error")}\n\n${String(e)}`
            : `${acc}\n\n${t(lang, "chat.streamInterrupted")} ${String(e)}`;
      }
    }
    setMsgs((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last !== undefined && last.role === "assistant") {
        next[next.length - 1] = {
          id: last.id,
          role: "assistant",
          content: acc === "" ? t(lang, "chat.emptyResponse") : acc,
          thinking: think === "" ? undefined : think,
          streaming: false,
          usage: finalUsage,
        };
      }
      return next;
    });
    setBusy(false);
    abortRef.current = null;
  };

  const send = async (): Promise<void> => {
    const text = input.trim();
    const cur = splitSel(sel);
    if ((text === "" && pendingImages.length === 0) || busy || cur === null || cur.model === "")
      return;
    const newUser: ChatMsg = {
      id: uid(),
      role: "user",
      content: text,
      images: pendingImages.length > 0 ? [...pendingImages] : undefined,
    };
    await runStream(msgs, newUser);
  };

  const regenerate = async (): Promise<void> => {
    if (busy || msgs.length === 0) return;
    const idx = msgs.map((m) => m.role).lastIndexOf("assistant");
    if (idx === -1) return;
    await runStream(msgs.slice(0, idx), null);
  };

  const copyMsg = async (m: ChatMsg): Promise<void> => {
    if (await copyText(m.content)) {
      setCopiedId(m.id);
      setTimeout(() => setCopiedId(null), 1500);
    }
  };

  const newChat = (): void => {
    if (busy) return;
    setMsgs([]);
  };

  const saveNow = (): void => {
    saveSession(safeLocalStorage(), {
      v: 1,
      sel,
      params,
      metrics,
      msgs: msgs
        .filter((m) => !m.streaming)
        .map(
          (m): SessionMsg => ({
            id: m.id,
            role: m.role,
            content: m.content,
            thinking: m.thinking,
            images: m.images?.map((im) => im.url),
            usage: m.usage,
          }),
        ),
    });
  };

  const saveNowRef = React.useRef(saveNow);
  saveNowRef.current = saveNow;

  // biome-ignore lint/correctness/useExhaustiveDependencies: state deps intentionally re-arm the debounce on every chat/param change
  React.useEffect(() => {
    if (busy) return;
    const t = setTimeout(() => saveNowRef.current(), 400);
    return () => clearTimeout(t);
  }, [msgs, sel, params, metrics, busy]);

  React.useEffect(() => {
    const h = (): void => saveNowRef.current();
    window.addEventListener("pagehide", h);
    return () => window.removeEventListener("pagehide", h);
  }, []);

  const curSel = splitSel(sel);
  const curThinking =
    curSel === null ? null : (groups.find((g) => g.info.id === curSel.pid)?.info.thinking ?? null);
  const firstErr = groups[0]?.error;
  const chatHint =
    chatErr !== null
      ? chatErrText(lang, chatErr)
      : groups.length === 0
        ? t(lang, "chat.loading")
        : sel === ""
          ? firstErr !== null && firstErr !== undefined
            ? chatErrText(lang, firstErr)
            : t(lang, "chat.noUsableModel")
          : t(lang, "chat.hintOk");

  return (
    <div className="chat">
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <select
          className="sel"
          value={sel}
          onChange={(e) => setSel(e.target.value)}
          disabled={busy}
        >
          {groups.length === 0 ? (
            <option value="">
              {chatErr !== null ? chatErrText(lang, chatErr) : t(lang, "chat.loadingModels")}
            </option>
          ) : null}
          {groups.map((g) => (
            <optgroup
              key={g.info.id}
              label={
                g.error !== null ? `${g.info.name} (${chatErrText(lang, g.error)})` : g.info.name
              }
            >
              {g.models.length === 0 ? (
                <option disabled value={`${g.info.id}::`}>
                  {t(lang, "chat.noModels")}
                </option>
              ) : (
                g.models.map((m) => (
                  <option key={`${g.info.id}::${m}`} value={`${g.info.id}::${m}`}>
                    {m}
                  </option>
                ))
              )}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          className="mini-btn"
          title={t(lang, "chat.paramsTitle")}
          onClick={() => setShowParams((v) => !v)}
        >
          {t(lang, "chat.paramsBtn", { icon: showParams ? "▾" : "▸" })}
        </button>
        {msgs.length > 0 && !busy ? (
          <button type="button" className="mini-btn" onClick={newChat}>
            {t(lang, "chat.new")}
          </button>
        ) : null}
        <span className="chat-hint" style={{ marginTop: 0 }}>
          {chatHint}
        </span>
      </div>
      {showParams ? (
        <div className="popover">
          <div className="prow">
            <span>{t(lang, "chat.temperature")}</span>
            <input
              className="pin"
              type="number"
              min="0"
              max="2"
              step="0.1"
              placeholder={t(lang, "chat.placeholderDefault")}
              value={params.temperature ?? ""}
              onChange={(e) => setParams({ ...params, temperature: parseNum(e.target.value) })}
            />
          </div>
          <div className="prow">
            <span>{t(lang, "chat.topP")}</span>
            <input
              className="pin"
              type="number"
              min="0"
              max="1"
              step="0.05"
              placeholder={t(lang, "chat.placeholderDefault")}
              value={params.topP ?? ""}
              onChange={(e) => setParams({ ...params, topP: parseNum(e.target.value) })}
            />
          </div>
          <div className="prow">
            <span>{t(lang, "chat.maxTokens")}</span>
            <input
              className="pin"
              type="number"
              min="1"
              step="1"
              placeholder={t(lang, "chat.placeholderModelDefault")}
              value={params.maxTokens ?? ""}
              onChange={(e) => setParams({ ...params, maxTokens: parseNum(e.target.value) })}
            />
          </div>
          <div className="prow col">
            <span>{t(lang, "chat.systemPrompt")}</span>
            <textarea
              className="psys"
              rows={2}
              placeholder={t(lang, "chat.placeholderOptional")}
              value={params.system}
              onChange={(e) => setParams({ ...params, system: e.target.value })}
            />
          </div>
          {curThinking !== null ? (
            <div className="prow">
              <span>{t(lang, "chat.thinking")}</span>
              <label className="chk">
                <input
                  type="checkbox"
                  checked={params.thinkingOn}
                  onChange={(e) => setParams({ ...params, thinkingOn: e.target.checked })}
                />
                {params.thinkingOn ? t(lang, "chat.thinkingOn") : t(lang, "chat.thinkingOff")}
              </label>
            </div>
          ) : null}
          <div className="prow">
            <span>{t(lang, "chat.footnote")}</span>
            <div className="checks">
              {(
                [
                  ["tokens", "chat.footnoteTokens"],
                  ["tps", "chat.footnoteTps"],
                  ["ttft", "chat.footnoteTtft"],
                  ["reasoning", "chat.footnoteReasoning"],
                ] as const
              ).map(([k, labelKey]) => (
                <label key={k} className="chk">
                  <input
                    type="checkbox"
                    checked={metrics[k]}
                    onChange={(e) => setMetrics({ ...metrics, [k]: e.target.checked })}
                  />
                  {t(lang, labelKey)}
                </label>
              ))}
            </div>
          </div>
          <div className="prow">
            <button type="button" className="mini-btn" onClick={() => setParams(defaultParams())}>
              {t(lang, "chat.resetParams")}
            </button>
          </div>
        </div>
      ) : null}
      <div className="chat-msgs" ref={scrollRef}>
        {msgs.length === 0 ? <div className="empty">{t(lang, "chat.empty")}</div> : null}
        {msgs.map((m, i) => {
          const usageLine = m.usage !== undefined ? formatUsage(m.usage, metrics) : "";
          const showCopy = m.role === "assistant" && m.content !== "" && m.streaming !== true;
          const showRegen =
            m.role === "assistant" && i === msgs.length - 1 && !busy && m.streaming !== true;
          return (
            <div className="msg-wrap" key={m.id}>
              <Bubble msg={m} />
              {usageLine !== "" || showCopy || showRegen ? (
                <div className="msg-foot">
                  {usageLine !== "" ? <span>{usageLine}</span> : null}
                  {showCopy ? (
                    <button type="button" className="mini-btn" onClick={() => void copyMsg(m)}>
                      {copiedId === m.id ? t(lang, "chat.copied") : t(lang, "chat.copy")}
                    </button>
                  ) : null}
                  {showRegen ? (
                    <button type="button" className="mini-btn" onClick={() => void regenerate()}>
                      {t(lang, "chat.regenerate")}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="chat-input">
        {pendingImages.length > 0 && (
          <div className="thumbs pending">
            {pendingImages.map((p) => (
              <span key={p.id} className="thumb-wrap">
                <img src={p.url} alt={t(lang, "chat.pendingAttachment")} className="thumb" />
                <button
                  type="button"
                  className="thumb-x"
                  title={t(lang, "chat.remove")}
                  onClick={() => setPendingImages((prev) => prev.filter((q) => q.id !== p.id))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {attachError !== null && <div className="attach-error">{attachError}</div>}
        <button
          type="button"
          className="attach-btn"
          title={t(lang, "chat.attach")}
          onClick={() => fileInputRef.current?.click()}
        >
          +
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <textarea
          value={input}
          placeholder={
            sel === ""
              ? t(lang, "chat.placeholderWaiting")
              : t(lang, "chat.placeholderModel", { m: splitSel(sel)?.model ?? "" })
          }
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {busy ? (
          <button type="button" className="chat-btn stop" onClick={() => abortRef.current?.abort()}>
            {t(lang, "chat.stop")}
          </button>
        ) : (
          <button
            type="button"
            className="chat-btn"
            disabled={
              (input.trim() === "" && pendingImages.length === 0) ||
              splitSel(sel)?.model === "" ||
              splitSel(sel) === null
            }
            onClick={() => void send()}
          >
            {t(lang, "chat.send")}
          </button>
        )}
      </div>
    </div>
  );
}

function Spark({ a, b }: { a: (number | null)[]; b: (number | null)[] }) {
  const { lang } = useUI();
  const pts = (arr: (number | null)[]): string => {
    const n = Math.max(2, arr.length);
    return arr
      .flatMap((v, i) =>
        v === null
          ? []
          : [
              `${((i / (n - 1)) * 100).toFixed(1)},${(40 - (Math.min(100, Math.max(0, v)) / 100) * 36 - 2).toFixed(1)}`,
            ],
      )
      .join(" ");
  };
  if (a.length < 2) return <div className="spark-empty" />;
  return (
    <svg className="spark" viewBox="0 0 100 40" preserveAspectRatio="none">
      <title>{t(lang, "gpu.sparkTitle")}</title>
      <polyline
        points={pts(a)}
        fill="none"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        style={{ stroke: "var(--spark-a)" }}
      />
      <polyline
        points={pts(b)}
        fill="none"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        style={{ stroke: "var(--spark-b)" }}
      />
    </svg>
  );
}

interface GpuSeries {
  util: (number | null)[];
  mem: (number | null)[];
}

function GpuCard({ gpu, hist }: { gpu: GpuState; hist: Record<number, GpuSeries> }) {
  const { lang } = useUI();
  return (
    <Card title={t(lang, "gpu.title", { count: gpu.gpus.length })}>
      {gpu.gpus.map((g) => {
        const memPct =
          g.memUsedMb !== null && g.memTotalMb !== null && g.memTotalMb > 0
            ? (g.memUsedMb / g.memTotalMb) * 100
            : null;
        return (
          <div key={g.index} className="gpu-row">
            <Row
              label={`${t(lang, "gpu.row", { index: g.index })}${g.name === "" ? "" : ` · ${g.name}`}`}
              value={g.utilPct === null ? "—" : t(lang, "gpu.util", { pct: g.utilPct })}
            />
            <div className="bar">
              <div style={{ width: `${Math.min(100, g.utilPct ?? 0).toFixed(0)}%` }} />
            </div>
            <Row
              label={t(lang, "gpu.memory")}
              value={
                g.memUsedMb !== null && g.memTotalMb !== null
                  ? `${(g.memUsedMb / 1024).toFixed(1)} / ${(g.memTotalMb / 1024).toFixed(1)} GB`
                  : "—"
              }
            />
            <Row
              label={t(lang, "gpu.tempPower")}
              value={`${g.tempC === null ? "—" : `${g.tempC}°C`} · ${g.powerW === null ? "—" : `${g.powerW.toFixed(0)}W`}`}
            />
            <Spark a={hist[g.index]?.util ?? []} b={hist[g.index]?.mem ?? []} />
            <div className="spark-cap">{t(lang, "gpu.sparkCap")}</div>
          </div>
        );
      })}
    </Card>
  );
}

/* ---------- app ---------- */

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

  const labels = history.map((s) => fmtTime(s.ts, lang));
  const g = (pick: (s: ChartPoint) => number | null): (number | null)[] => history.map(pick);
  const hasValue = (pick: (s: ChartPoint) => number | null): boolean =>
    history.some((s) => pick(s) !== null);
  const hasAny = (pred: (s: ChartPoint) => boolean): boolean => history.some((s) => pred(s));

  const c = CHART[theme];
  const requestSeries: Series[] = [
    { name: t(lang, "requests.running"), data: g((s) => s.requests.running), color: c.blue },
    { name: t(lang, "requests.queued"), data: g((s) => s.requests.queued), color: c.amber },
  ];
  if (hasValue((s) => s.requests.paused)) {
    requestSeries.push({
      name: t(lang, "requests.paused"),
      data: g((s) => s.requests.paused),
      color: c.violet,
    });
  }
  if (hasValue((s) => s.requests.swapped)) {
    requestSeries.push({
      name: t(lang, "requests.swapped"),
      data: g((s) => s.requests.swapped),
      color: c.pink,
    });
  }

  const tpSeries: Series[] = [
    {
      name: t(lang, "throughput.seriesGen"),
      data: g((s) => s.throughput.generationTps),
      color: c.green,
    },
  ];
  if (hasValue((s) => s.throughput.prefillTps)) {
    tpSeries.push({
      name: t(lang, "throughput.seriesPrefill"),
      data: g((s) => s.throughput.prefillTps),
      color: c.orange,
    });
  }
  if (hasValue((s) => s.throughput.prefillEffectiveTps)) {
    tpSeries.push({
      name: t(lang, "throughput.seriesPrefillEff"),
      data: g((s) => s.throughput.prefillEffectiveTps),
      color: c.blueLight,
    });
  }

  const kvSeries: Series[] = [
    {
      name: t(lang, "kv.seriesUsage"),
      data: g((s) => (s.cache.kvUsagePct === null ? null : s.cache.kvUsagePct * 100)),
      color: c.violet,
    },
  ];
  if (hasAny((s) => s.cache.hostUsedTokens !== null && s.cache.hostTotalTokens !== null)) {
    kvSeries.push({
      name: t(lang, "kv.seriesHostTier"),
      data: g((s) =>
        s.cache.hostUsedTokens !== null &&
        s.cache.hostTotalTokens !== null &&
        s.cache.hostTotalTokens > 0
          ? (s.cache.hostUsedTokens / s.cache.hostTotalTokens) * 100
          : null,
      ),
      color: c.teal,
    });
  }

  const ttftSeries: Series[] = hasAny((s) => s.latency.ttft !== null)
    ? [
        {
          name: t(lang, "latency.ttftP50"),
          data: g((s) => s.latency.ttft?.p50 ?? null),
          color: c.blue,
        },
        {
          name: t(lang, "latency.ttftP90"),
          data: g((s) => s.latency.ttft?.p90 ?? null),
          color: c.amber,
        },
        {
          name: t(lang, "latency.ttftP99"),
          data: g((s) => s.latency.ttft?.p99 ?? null),
          color: c.red,
        },
      ]
    : [];

  const lq =
    snap === null
      ? null
      : {
          ttft: hq(snap.latency.ttft),
          e2e: hq(snap.latency.e2e),
          tpot: hq(snap.latency.tpot),
          queue: hq(snap.latency.queueWait),
        };

  const kv = snap === null ? null : snap.cache;
  const kvPct = kv !== null && kv.kvUsagePct !== null ? kv.kvUsagePct : null;
  const hostPct =
    kv !== null &&
    kv.hostUsedTokens !== null &&
    kv.hostTotalTokens !== null &&
    kv.hostTotalTokens > 0
      ? kv.hostUsedTokens / kv.hostTotalTokens
      : null;
  const hitRate = kv !== null ? (kv.cumulativeHitRate ?? kv.hitRate) : null;

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
          <>
            <section className="grid4">
              <Card title={t(lang, "requests.title")}>
                <div className="stats">
                  <Stat
                    label={t(lang, "requests.running")}
                    value={fmtNum(snap?.requests.running ?? null, 0)}
                  />
                  <Stat
                    label={t(lang, "requests.queued")}
                    value={fmtNum(snap?.requests.queued ?? null, 0)}
                  />
                  {snap !== null && snap.requests.paused !== null ? (
                    <Stat
                      label={t(lang, "requests.paused")}
                      value={fmtNum(snap.requests.paused, 0)}
                    />
                  ) : null}
                  {snap !== null && snap.requests.swapped !== null ? (
                    <Stat
                      label={t(lang, "requests.swapped")}
                      value={fmtNum(snap.requests.swapped, 0)}
                    />
                  ) : null}
                </div>
                <LineChart series={requestSeries} labels={labels} />
              </Card>

              <Card title={t(lang, "throughput.title")}>
                <div className="stats">
                  <Stat
                    label={t(lang, "throughput.generation")}
                    value={fmtNum(snap?.throughput.generationTps ?? null)}
                    sub={t(lang, "throughput.tokPerSec")}
                  />
                  {snap !== null && snap.throughput.prefillTps !== null ? (
                    <Stat
                      label={t(lang, "throughput.prefill")}
                      value={fmtNum(snap.throughput.prefillTps)}
                      sub={t(lang, "throughput.tokPerSec")}
                    />
                  ) : null}
                </div>
                {snap !== null && snap.throughput.requestsPerSec !== null ? (
                  <Row
                    label={t(lang, "throughput.rps")}
                    value={`${snap.throughput.requestsPerSec.toFixed(2)} req/s`}
                  />
                ) : null}
                {snap !== null && (snap.extras["tflopsAllGpus"] ?? null) !== null ? (
                  <Row
                    label={t(lang, "throughput.estCompute")}
                    value={`${(snap.extras["tflopsAllGpus"] ?? 0).toFixed(1)} TFLOPS`}
                  />
                ) : null}
                {snap !== null && (snap.extras["memBandwidthGbsAllGpus"] ?? null) !== null ? (
                  <Row
                    label={t(lang, "throughput.estMemBw")}
                    value={`${(snap.extras["memBandwidthGbsAllGpus"] ?? 0).toFixed(0)} GB/s`}
                  />
                ) : null}
                <LineChart series={tpSeries} labels={labels} />
              </Card>

              <Card title={t(lang, "kv.title")}>
                {kvPct === null ? (
                  <div className="empty">{t(lang, "kv.empty")}</div>
                ) : (
                  <>
                    <div className="big">{(kvPct * 100).toFixed(1)}%</div>
                    <div className="bar">
                      <div style={{ width: `${Math.min(100, kvPct * 100).toFixed(1)}%` }} />
                    </div>
                    {kv !== null ? (
                      <>
                        <Row
                          label={t(lang, "kv.usedTotal")}
                          value={`${fmtTok(kv.kvUsedTokens)} / ${fmtTok(kv.kvTotalTokens)}`}
                        />
                        <Row label={t(lang, "kv.hitRate")} value={fmtPct(hitRate)} />
                        {kv.kvAvailableTokens !== null ? (
                          <Row
                            label={t(lang, "kv.available")}
                            value={fmtTok(kv.kvAvailableTokens)}
                          />
                        ) : null}
                        {kv.deviceHitTps !== null ||
                        kv.hostHitTps !== null ||
                        kv.storageHitTps !== null ? (
                          <Row
                            label={t(lang, "kv.hits")}
                            value={`${fmtNum(kv.deviceHitTps)} / ${fmtNum(kv.hostHitTps)} / ${fmtNum(kv.storageHitTps)}`}
                          />
                        ) : null}
                        {hostPct !== null ? (
                          <Row label={t(lang, "kv.hostTier")} value={fmtPct(hostPct)} />
                        ) : null}
                      </>
                    ) : null}
                  </>
                )}
                <LineChart series={kvSeries} labels={labels} />
              </Card>

              <Card title={t(lang, "latency.title")}>
                {lq !== null ? (
                  <>
                    <div className="big">
                      {lq.ttft.p50 === null ? "—" : `${lq.ttft.p50.toFixed(2)}s`}
                    </div>
                    <div className="stat-label">{t(lang, "latency.ttftP50")}</div>
                    <Row
                      label={t(lang, "latency.ttftP9099")}
                      value={`${lq.ttft.p90 === null ? "—" : lq.ttft.p90.toFixed(2)} / ${lq.ttft.p99 === null ? "—" : lq.ttft.p99.toFixed(2)}`}
                    />
                    <Row
                      label={t(lang, "latency.e2eP5099")}
                      value={`${lq.e2e.p50 === null ? "—" : lq.e2e.p50.toFixed(2)} / ${lq.e2e.p99 === null ? "—" : lq.e2e.p99.toFixed(2)}`}
                    />
                    <Row
                      label={t(lang, "latency.tpotP50")}
                      value={lq.tpot.p50 === null ? "—" : lq.tpot.p50.toFixed(3)}
                    />
                    <Row
                      label={t(lang, "latency.queueP50")}
                      value={lq.queue.p50 === null ? "—" : lq.queue.p50.toFixed(3)}
                    />
                  </>
                ) : (
                  <div className="empty">{t(lang, "latency.empty")}</div>
                )}
                <LineChart
                  series={
                    ttftSeries.length > 0
                      ? ttftSeries
                      : [{ name: t(lang, "latency.ttftP50"), data: [], color: c.blue }]
                  }
                  labels={labels}
                />
              </Card>
            </section>

            <section className="grid5">
              <Card title={t(lang, "tokens.title")}>
                <Row
                  label={t(lang, "tokens.prompt")}
                  value={fmtTok(snap?.tokens.promptTotal ?? null)}
                />
                <Row
                  label={t(lang, "tokens.generation")}
                  value={fmtTok(snap?.tokens.generationTotal ?? null)}
                />
                <Row
                  label={t(lang, "tokens.cached")}
                  value={fmtTok(snap?.tokens.cachedTotal ?? null)}
                />
                <Row
                  label={t(lang, "tokens.completed")}
                  value={fmtNum(snap?.counts.requestsCompletedTotal ?? null, 0)}
                />
              </Card>

              <Card title={t(lang, "faults.title")}>
                <div className="stats">
                  <Stat
                    label={t(lang, "faults.retracted")}
                    value={fmtNum(snap?.faults.retractedTotal ?? null, 0)}
                  />
                  <Stat
                    label={t(lang, "faults.preempted")}
                    value={fmtNum(snap?.faults.preemptedTotal ?? null, 0)}
                  />
                </div>
                <div className="caption">{t(lang, "faults.caption")}</div>
              </Card>

              <Card title={t(lang, "extras.title")}>
                {snap !== null && snap.capabilities["mamba"] ? (
                  <Row
                    label={t(lang, "extras.mambaOccupancy")}
                    value={fmtPct(snap.extras["mambaUsage"] ?? null)}
                  />
                ) : null}
                {snap !== null && snap.extras["loadBackTokensTotal"] !== null ? (
                  <Row
                    label={t(lang, "extras.hicacheLoadBack")}
                    value={fmtTok(snap.extras["loadBackTokensTotal"] ?? null)}
                  />
                ) : null}
                {snap !== null && snap.extras["fwdOccupancy"] !== null ? (
                  <Row
                    label={t(lang, "extras.fwdOccupancy")}
                    value={fmtPct(snap.extras["fwdOccupancy"] ?? null)}
                  />
                ) : null}
                {snap !== null && (snap.extras["mambaAvailableTokens"] ?? null) !== null ? (
                  <Row
                    label={t(lang, "extras.mambaSlots")}
                    value={fmtNum(snap.extras["mambaAvailableTokens"] ?? null, 0)}
                  />
                ) : null}
                {snap !== null && (snap.extras["specAcceptRate"] ?? null) !== null ? (
                  <Row
                    label={t(lang, "extras.specAccept")}
                    value={`${((snap.extras["specAcceptRate"] ?? 0) * 100).toFixed(1)}% / ${fmtNum(snap.extras["specAcceptLength"] ?? null)}`}
                  />
                ) : null}
                {snap === null ? <div className="empty">{t(lang, "extras.empty")}</div> : null}
              </Card>

              <Card title={t(lang, "engine.title")}>
                <Row
                  label={t(lang, "engine.adapter")}
                  value={snap?.engine.adapter ?? target?.adapter ?? "—"}
                />
                <Row
                  label={t(lang, "engine.model")}
                  value={snap?.engine.model ?? target?.model ?? "—"}
                />
                <Row
                  label={t(lang, "engine.version")}
                  value={snap?.engine.version ?? target?.version ?? "—"}
                />
                <Row label={t(lang, "engine.rtt")} value={`${snap?.engine.rttMs ?? 0}ms`} />
                <Row label={t(lang, "engine.url")} value={target?.url ?? "—"} />
              </Card>
              {gpu !== null && gpu.available ? <GpuCard gpu={gpu} hist={gpuHist} /> : null}
            </section>
          </>
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
