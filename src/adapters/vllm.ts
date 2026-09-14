/** vLLM adapter: /metrics (Prometheus) + /version + /health. */

import { emptySnapshot, type HistogramBuckets, type Snapshot } from "../core/model.ts";
import { findHistogram, findSeries, type Parsed, parsePrometheus } from "../core/prom.ts";
import { fetchText, stripSlashes } from "./http.ts";
import type { AdapterMeta, EngineAdapter } from "./types.ts";

const V = "vllm:";

function gauge(p: Parsed, name: string): number | null {
  const s = findSeries(p, `${V}${name}`);
  return s === null ? null : s.value;
}

function gaugeAlt(p: Parsed, primary: string, fallback: string): number | null {
  return gauge(p, primary) ?? gauge(p, fallback);
}

function histogram(p: Parsed, name: string): HistogramBuckets | null {
  const h = findHistogram(p, `${V}${name}`);
  if (h === null) return null;
  return { buckets: h.buckets, sum: h.sum, count: h.count };
}

function histogramAlt(p: Parsed, primary: string, fallback: string): HistogramBuckets | null {
  return histogram(p, primary) ?? histogram(p, fallback);
}

/** Pure normalization — extracted so unit tests can feed it a fixture parse. */
export function normalizeVllm(p: Parsed, meta: AdapterMeta, ts: number): Snapshot {
  const s = emptySnapshot(ts, "vllm");
  s.engine.model = meta.model;
  s.engine.version = meta.version;
  s.engine.healthy = true;

  s.requests.running = gauge(p, "num_requests_running");
  s.requests.queued = gauge(p, "num_requests_waiting");
  s.requests.swapped = gauge(p, "num_requests_swapped");
  s.faults.preemptedTotal = gauge(p, "num_preemptions_total");

  s.cache.kvUsagePct = gaugeAlt(p, "kv_cache_usage_perc", "gpu_cache_usage_perc");
  s.cache.prefixHitsTotal = gauge(p, "prefix_cache_hits_total");
  s.cache.prefixQueriesTotal = gauge(p, "prefix_cache_queries_total");
  if (s.cache.prefixHitsTotal !== null) s.capabilities.prefixCache = true;

  s.tokens.promptTotal = gauge(p, "prompt_tokens_total");
  s.tokens.generationTotal = gauge(p, "generation_tokens_total");
  s.counts.requestsCompletedTotal = gauge(p, "request_success_total");

  s.throughput.generationTps = gauge(p, "avg_generation_throughput_toks_per_s");
  s.throughput.prefillTps = gauge(p, "avg_prompt_throughput_toks_per_s");

  s.latency.ttft = histogram(p, "time_to_first_token_seconds");
  s.latency.e2e = histogram(p, "e2e_request_latency_seconds");
  s.latency.tpot = histogramAlt(
    p,
    "request_time_per_output_token_seconds",
    "inter_token_latency_seconds",
  );
  s.latency.queueWait = histogram(p, "request_queue_time_seconds");

  if (
    s.cache.hitRate === null &&
    s.cache.prefixHitsTotal !== null &&
    s.cache.prefixQueriesTotal !== null
  ) {
    if (s.cache.prefixQueriesTotal > 0) {
      s.cache.rollingHitRate = s.cache.prefixHitsTotal / s.cache.prefixQueriesTotal;
    }
  }
  return s;
}

function parseVersion(text: string): string | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j["version"] === "string") return j["version"] as string;
  } catch {
    // Older vLLM releases return the bare version string.
  }
  const t = text.trim();
  return t === "" ? null : t;
}

function modelFromMetrics(text: string): string | null {
  const m = text.match(/model_name="([^"]+)"/);
  return m !== null && m[1] !== undefined ? m[1] : null;
}

export const vllm: EngineAdapter = {
  id: "vllm",

  async detect(url: string) {
    const r = await fetchText(`${stripSlashes(url)}/version`);
    if (!r.ok) return null;
    return parseVersion(r.text) !== null ? "vllm" : null;
  },

  async check(url: string) {
    const r = await fetchText(`${stripSlashes(url)}/health`);
    return r.ok;
  },

  async describe(url: string): Promise<AdapterMeta> {
    const [vr, m] = await Promise.all([
      fetchText(`${stripSlashes(url)}/version`),
      fetchText(`${stripSlashes(url)}/metrics`),
    ]);
    return {
      model: m.ok ? modelFromMetrics(m.text) : null,
      version: vr.ok ? parseVersion(vr.text) : null,
    };
  },

  async sample(url: string, ts: number): Promise<Snapshot> {
    const base = stripSlashes(url);
    const s = emptySnapshot(ts, "vllm");
    const [m, vr] = await Promise.all([fetchText(`${base}/metrics`), fetchText(`${base}/version`)]);
    if (!m.ok) return s;
    s.engine.rttMs = Math.round(m.rttMs * 10) / 10;
    const meta: AdapterMeta = {
      model: modelFromMetrics(m.text),
      version: vr.ok ? parseVersion(vr.text) : null,
    };
    return normalizeVllm(parsePrometheus(m.text), meta, ts);
  },
};
