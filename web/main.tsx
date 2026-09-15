import DOMPurify from "dompurify";
import * as echarts from "echarts";
import hljs from "highlight.js";
import { marked } from "marked";
import * as React from "react";
import { createRoot } from "react-dom/client";

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
  throughput: { generationTps: number | null; prefillTps: number | null };
  cache: {
    kvUsagePct: number | null;
    hostUsedTokens: number | null;
    hostTotalTokens: number | null;
  };
  latency: { ttft: { p50: number | null; p90: number | null; p99: number | null } | null };
}

const fmtTime = (ts: number): string => new Date(ts).toLocaleTimeString("en-GB", { hour12: false });

const uid = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/* ---------- echarts line chart ---------- */

interface Series {
  name: string;
  data: (number | null)[];
  color: string;
}

function LineChart({ series, labels }: { series: Series[]; labels: string[] }) {
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
    chart.setOption({
      backgroundColor: "transparent",
      grid: { left: 46, right: 26, top: series.length > 1 ? 30 : 18, bottom: 22 },
      tooltip: { trigger: "axis" },
      legend:
        series.length > 1
          ? { top: 0, textStyle: { color: "#8b949e", fontSize: 11 }, itemWidth: 14, itemHeight: 8 }
          : undefined,
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { color: "#6e7681", fontSize: 10 },
        axisLine: { lineStyle: { color: "#21262d" } },
        boundaryGap: false,
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#6e7681", fontSize: 10 },
        splitLine: { lineStyle: { color: "#1c2128" } },
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
  }, [series, labels]);

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
      <span>{label}</span>
      <b>{value}</b>
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
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function Bubble({ msg }: { msg: ChatMsg }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (el === null || msg.content === "") return;
    el.innerHTML = DOMPurify.sanitize(marked.parse(msg.content, { async: false }) as string);
    for (const c of Array.from(el.querySelectorAll<HTMLElement>("pre code"))) {
      hljs.highlightElement(c);
    }
  }, [msg.content]);
  return (
    <div className={`bubble ${msg.role}`}>
      {msg.role === "user" && msg.images !== undefined && msg.images.length > 0 ? (
        <div className="thumbs">
          {msg.images.map((img) => (
            <img key={img.id} src={img.url} alt="attachment" className="thumb" />
          ))}
        </div>
      ) : null}
      {msg.thinking !== undefined && msg.thinking !== "" ? (
        <details className="thinking">
          <summary>thinking</summary>
          <pre>{msg.thinking}</pre>
        </details>
      ) : null}
      <div ref={ref} />
      {msg.streaming ? <span style={{ color: "#38bdf8", animation: "none" }}>▍</span> : null}
    </div>
  );
}

interface ProviderInfo {
  id: string;
  name: string;
  default: boolean;
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

function Chat() {
  const [sel, setSel] = React.useState<string>("");
  const [groups, setGroups] = React.useState<ProviderGroup[]>([]);
  const [chatErr, setChatErr] = React.useState<string | null>(null);
  const [msgs, setMsgs] = React.useState<ChatMsg[]>([]);
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
        setAttachError("Up to 4 images per message.");
        break;
      }
      room -= 1;
      if (file.size > 8 * 1024 * 1024) {
        setAttachError(`${file.name} exceeds 8MB — skipped.`);
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
          setAttachError(`${file.name} could not be decoded — skipped.`);
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
        if (def !== undefined && first !== undefined) setSel(`${def.info.id}::${first}`);
      } catch {
        if (!stop) setChatErr("cannot reach chat API");
      }
    })();
    return () => {
      stop = true;
    };
  }, []);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && msgs.length > 0) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const send = async (): Promise<void> => {
    const text = input.trim();
    const cur = splitSel(sel);
    if ((text === "" && pendingImages.length === 0) || busy || cur === null || cur.model === "")
      return;
    const history = msgs.map((m): { role: string; content: string | ContentPart[] } => ({
      role: m.role,
      content: toContent(m.content, m.images !== undefined ? m.images : []),
    }));
    history.push({ role: "user", content: toContent(text, pendingImages) });
    setMsgs([
      ...msgs,
      {
        id: uid(),
        role: "user",
        content: text,
        images: pendingImages.length > 0 ? [...pendingImages] : undefined,
      },
      { id: uid(), role: "assistant", content: "", streaming: true },
    ]);
    setInput("");
    setPendingImages([]);
    setAttachError(null);
    setBusy(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    let acc = "";
    let think = "";
    try {
      const r = await fetch(`/api/chat/stream?provider=${encodeURIComponent(cur.pid)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: cur.model, messages: history }),
        signal: ctl.signal,
      });
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
            const delta = j.choices?.[0]?.delta;
            if (typeof delta?.content === "string") acc += delta.content;
            if (typeof delta?.reasoning_content === "string") think += delta.reasoning_content;
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
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") {
        acc =
          acc === ""
            ? `**error**\n\n${String(e)}`
            : `${acc}\n\n**[stream interrupted]** ${String(e)}`;
      }
    }
    setMsgs((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last !== undefined && last.role === "assistant") {
        next[next.length - 1] = {
          id: last.id,
          role: "assistant",
          content: acc === "" ? "*(empty response)*" : acc,
          thinking: think === "" ? undefined : think,
          streaming: false,
        };
      }
      return next;
    });
    setBusy(false);
    abortRef.current = null;
  };

  return (
    <div className="chat">
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <select
          className="sel"
          value={sel}
          onChange={(e) => setSel(e.target.value)}
          disabled={busy}
        >
          {groups.length === 0 ? <option value="">{chatErr ?? "loading models…"}</option> : null}
          {groups.map((g) => (
            <optgroup
              key={g.info.id}
              label={g.error !== null ? `${g.info.name} (${g.error})` : g.info.name}
            >
              {g.models.length === 0 ? (
                <option disabled value={`${g.info.id}::`}>
                  no models
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
        <span className="chat-hint" style={{ marginTop: 0 }}>
          {chatErr ??
            (groups.length === 0
              ? "loading…"
              : sel === ""
                ? (groups[0]?.error ?? "no usable model")
                : "OpenAI-compatible · ⏎ send · ⇧⏎ newline")}
        </span>
      </div>
      <div className="chat-msgs" ref={scrollRef}>
        {msgs.length === 0 ? (
          <div className="empty">ask anything — chat is proxied to the selected provider</div>
        ) : null}
        {msgs.map((m) => (
          <Bubble key={m.id} msg={m} />
        ))}
      </div>
      <div className="chat-input">
        {pendingImages.length > 0 && (
          <div className="thumbs pending">
            {pendingImages.map((p) => (
              <span key={p.id} className="thumb-wrap">
                <img src={p.url} alt="pending attachment" className="thumb" />
                <button
                  type="button"
                  className="thumb-x"
                  title="remove"
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
          title="attach image"
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
            sel === "" ? "waiting for model list…" : `message ${splitSel(sel)?.model ?? ""}…`
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
            stop
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
            send
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- app ---------- */

function App() {
  const [targets, setTargets] = React.useState<Target[]>([]);
  const [sel, setSel] = React.useState<string | null>(null);
  const [snap, setSnap] = React.useState<Snapshot | null>(null);
  const [history, setHistory] = React.useState<ChartPoint[]>([]);
  const [err, setErr] = React.useState<string | null>(null);
  const [booted, setBooted] = React.useState(false);
  const [view, setView] = React.useState<"monitor" | "chat">("monitor");

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
      .catch(() => setErr("cannot reach llm-cockpit API"))
      .finally(() => setBooted(true));
  }, []);

  React.useEffect(() => {
    if (sel === null) return;
    let stop = false;
    const tick = async (): Promise<void> => {
      try {
        const [s, h] = await Promise.all([
          fetch(`/api/snapshot?target=${encodeURIComponent(sel)}`).then(
            (r) => r.json() as Promise<{ snapshot: Snapshot | null }>,
          ),
          fetch(`/api/history?target=${encodeURIComponent(sel)}&sec=900&compact=1`).then(
            (r) => r.json() as Promise<{ points: ChartPoint[] }>,
          ),
        ]);
        if (stop) return;
        setSnap(s.snapshot);
        setHistory(h.points);
        setErr(null);
      } catch {
        if (!stop) setErr("cannot reach llm-cockpit API");
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
  const online = target !== null && target.status === "online";

  const labels = history.map((s) => fmtTime(s.ts));
  const g = (pick: (s: ChartPoint) => number | null): (number | null)[] => history.map(pick);
  const hasValue = (pick: (s: ChartPoint) => number | null): boolean =>
    history.some((s) => pick(s) !== null);
  const hasAny = (pred: (s: ChartPoint) => boolean): boolean => history.some((s) => pred(s));

  const requestSeries: Series[] = [
    { name: "running", data: g((s) => s.requests.running), color: "#38bdf8" },
    { name: "queued", data: g((s) => s.requests.queued), color: "#fbbf24" },
  ];
  if (hasValue((s) => s.requests.paused)) {
    requestSeries.push({ name: "paused", data: g((s) => s.requests.paused), color: "#a78bfa" });
  }
  if (hasValue((s) => s.requests.swapped)) {
    requestSeries.push({ name: "swapped", data: g((s) => s.requests.swapped), color: "#f472b6" });
  }

  const tpSeries: Series[] = [
    { name: "generation tok/s", data: g((s) => s.throughput.generationTps), color: "#34d399" },
  ];
  if (hasValue((s) => s.throughput.prefillTps)) {
    tpSeries.push({
      name: "prefill tok/s",
      data: g((s) => s.throughput.prefillTps),
      color: "#fb923c",
    });
  }

  const kvSeries: Series[] = [
    {
      name: "kv usage %",
      data: g((s) => (s.cache.kvUsagePct === null ? null : s.cache.kvUsagePct * 100)),
      color: "#a78bfa",
    },
  ];
  if (hasAny((s) => s.cache.hostUsedTokens !== null && s.cache.hostTotalTokens !== null)) {
    kvSeries.push({
      name: "host tier %",
      data: g((s) =>
        s.cache.hostUsedTokens !== null &&
        s.cache.hostTotalTokens !== null &&
        s.cache.hostTotalTokens > 0
          ? (s.cache.hostUsedTokens / s.cache.hostTotalTokens) * 100
          : null,
      ),
      color: "#2dd4bf",
    });
  }

  const ttftSeries: Series[] = hasAny((s) => s.latency.ttft !== null)
    ? [
        { name: "TTFT p50", data: g((s) => s.latency.ttft?.p50 ?? null), color: "#38bdf8" },
        { name: "TTFT p90", data: g((s) => s.latency.ttft?.p90 ?? null), color: "#fbbf24" },
        { name: "TTFT p99", data: g((s) => s.latency.ttft?.p99 ?? null), color: "#f87171" },
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
      <div className="wrap">
        <header className="hdr">
          <div className="brand">
            <span className="logo">◍</span>
            <span className="wordmark">
              LLM <em>Cockpit</em>
            </span>
          </div>
        </header>
        <div className="banner">
          no targets configured — add one to <code>cockpit.config.yaml</code>
        </div>
      </div>
    );
  }

  return (
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
              monitor
            </button>
            <button
              type="button"
              className={view === "chat" ? "on" : undefined}
              onClick={() => setView("chat")}
            >
              chat
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
          <span
            className="badge"
            style={{
              background: online ? "rgba(52,211,153,.15)" : "rgba(248,113,113,.15)",
              color: online ? "#34d399" : "#f87171",
            }}
          >
            {target === null ? "no target" : target.status}
          </span>
          {snap !== null ? (
            <span className="meta">
              {snap.engine.model ?? target?.model ?? "—"}
              {snap.engine.version !== null ? ` · v${snap.engine.version}` : ""} ·{" "}
              {snap.engine.adapter} · {snap.engine.rttMs}ms
            </span>
          ) : null}
        </div>
      </header>

      {err !== null ? <div className="banner">{err}</div> : null}
      {snap !== null && !snap.engine.healthy ? (
        <div className="banner">
          engine unreachable — is it running? if metrics are missing, start it with{" "}
          <code>--enable-metrics</code>
        </div>
      ) : null}

      <div className={`view${view === "monitor" ? "" : " hidden"}`}>
        <>
          <section className="grid4">
            <Card title="requests">
              <div className="stats">
                <Stat label="running" value={fmtNum(snap?.requests.running ?? null, 0)} />
                <Stat label="queued" value={fmtNum(snap?.requests.queued ?? null, 0)} />
                {snap !== null && snap.requests.paused !== null ? (
                  <Stat label="paused" value={fmtNum(snap.requests.paused, 0)} />
                ) : null}
                {snap !== null && snap.requests.swapped !== null ? (
                  <Stat label="swapped" value={fmtNum(snap.requests.swapped, 0)} />
                ) : null}
              </div>
              <LineChart series={requestSeries} labels={labels} />
            </Card>

            <Card title="throughput">
              <div className="stats">
                <Stat
                  label="generation"
                  value={fmtNum(snap?.throughput.generationTps ?? null)}
                  sub="tok/s"
                />
                {snap !== null && snap.throughput.prefillTps !== null ? (
                  <Stat label="prefill" value={fmtNum(snap.throughput.prefillTps)} sub="tok/s" />
                ) : null}
              </div>
              <LineChart series={tpSeries} labels={labels} />
            </Card>

            <Card title="kv cache">
              {kvPct === null ? (
                <div className="empty">no kv data</div>
              ) : (
                <>
                  <div className="big">{(kvPct * 100).toFixed(1)}%</div>
                  <div className="bar">
                    <div style={{ width: `${Math.min(100, kvPct * 100).toFixed(1)}%` }} />
                  </div>
                  {kv !== null ? (
                    <>
                      <Row
                        label="used / total"
                        value={`${fmtTok(kv.kvUsedTokens)} / ${fmtTok(kv.kvTotalTokens)}`}
                      />
                      <Row label="cache hit rate" value={fmtPct(hitRate)} />
                      {hostPct !== null ? (
                        <Row label="host tier (L2)" value={fmtPct(hostPct)} />
                      ) : null}
                    </>
                  ) : null}
                </>
              )}
              <LineChart series={kvSeries} labels={labels} />
            </Card>

            <Card title="latency (s)">
              {lq !== null ? (
                <>
                  <div className="big">
                    {lq.ttft.p50 === null ? "—" : `${lq.ttft.p50.toFixed(2)}s`}
                  </div>
                  <div className="stat-label">TTFT p50</div>
                  <Row
                    label="TTFT p90 / p99"
                    value={`${lq.ttft.p90 === null ? "—" : lq.ttft.p90.toFixed(2)} / ${lq.ttft.p99 === null ? "—" : lq.ttft.p99.toFixed(2)}`}
                  />
                  <Row
                    label="E2E p50 / p99"
                    value={`${lq.e2e.p50 === null ? "—" : lq.e2e.p50.toFixed(2)} / ${lq.e2e.p99 === null ? "—" : lq.e2e.p99.toFixed(2)}`}
                  />
                  <Row
                    label="TPOT p50"
                    value={lq.tpot.p50 === null ? "—" : lq.tpot.p50.toFixed(3)}
                  />
                  <Row
                    label="queue wait p50"
                    value={lq.queue.p50 === null ? "—" : lq.queue.p50.toFixed(3)}
                  />
                </>
              ) : (
                <div className="empty">no latency data</div>
              )}
              <LineChart
                series={
                  ttftSeries.length > 0
                    ? ttftSeries
                    : [{ name: "TTFT p50", data: [], color: "#38bdf8" }]
                }
                labels={labels}
              />
            </Card>
          </section>

          <section className="grid4">
            <Card title="tokens (cumulative)">
              <Row label="prompt" value={fmtTok(snap?.tokens.promptTotal ?? null)} />
              <Row label="generation" value={fmtTok(snap?.tokens.generationTotal ?? null)} />
              <Row label="cached" value={fmtTok(snap?.tokens.cachedTotal ?? null)} />
              <Row
                label="requests completed"
                value={fmtNum(snap?.counts.requestsCompletedTotal ?? null, 0)}
              />
            </Card>

            <Card title="faults">
              <div className="stats">
                <Stat label="retracted" value={fmtNum(snap?.faults.retractedTotal ?? null, 0)} />
                <Stat label="preempted" value={fmtNum(snap?.faults.preemptedTotal ?? null, 0)} />
              </div>
              <Row label="scope" value="cumulative since engine start" />
            </Card>

            <Card title="extras">
              {snap !== null && snap.capabilities["mamba"] ? (
                <Row label="mamba occupancy" value={fmtPct(snap.extras["mambaUsage"] ?? null)} />
              ) : null}
              {snap !== null && snap.extras["loadBackTokensTotal"] !== null ? (
                <Row
                  label="hicache load-back tokens"
                  value={fmtTok(snap.extras["loadBackTokensTotal"] ?? null)}
                />
              ) : null}
              {snap !== null && snap.extras["fwdOccupancy"] !== null ? (
                <Row
                  label="forward occupancy"
                  value={fmtPct(snap.extras["fwdOccupancy"] ?? null)}
                />
              ) : null}
              {snap === null ? <div className="empty">no data</div> : null}
            </Card>

            <Card title="engine">
              <Row label="adapter" value={snap?.engine.adapter ?? target?.adapter ?? "—"} />
              <Row label="model" value={snap?.engine.model ?? target?.model ?? "—"} />
              <Row label="version" value={snap?.engine.version ?? target?.version ?? "—"} />
              <Row label="probe rtt" value={`${snap?.engine.rttMs ?? 0}ms`} />
              <Row label="url" value={target?.url ?? "—"} />
            </Card>
          </section>
        </>
      </div>
      <div className={`view${view === "chat" ? "" : " hidden"}`}>
        <Chat />
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl !== null) createRoot(rootEl).render(<App />);
