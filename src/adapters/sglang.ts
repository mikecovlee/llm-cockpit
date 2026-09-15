/** SGLang adapter: /metrics (Prometheus) + /get_server_info + /health. */

import { emptySnapshot, type HistogramBuckets, type Snapshot } from "../core/model.ts";
import {
  findHistogram,
  findSeries,
  type Parsed,
  parsePrometheus,
  sumSeries,
} from "../core/prom.ts";
import { fetchText, stripSlashes } from "./http.ts";
import type { AdapterMeta, EngineAdapter } from "./types.ts";

const G = "sglang:";
const G_ALT = "sglang_";

function gauge(p: Parsed, name: string): number | null {
  const s = findSeries(p, `${G}${name}`) ?? findSeries(p, `${G_ALT}${name}`);
  return s === null ? null : s.value;
}

function counter(p: Parsed, name: string): number | null {
  return sumSeries(p, `${G}${name}`) ?? sumSeries(p, `${G_ALT}${name}`);
}

function histogram(p: Parsed, name: string): HistogramBuckets | null {
  const h = findHistogram(p, `${G}${name}`) ?? findHistogram(p, `${G_ALT}${name}`);
  if (h === null) return null;
  return { buckets: h.buckets, sum: h.sum, count: h.count };
}

/** Pure normalization — extracted so unit tests can feed it a fixture parse. */
export function normalizeSglang(p: Parsed, meta: AdapterMeta, ts: number): Snapshot {
  const s = emptySnapshot(ts, "sglang");
  s.engine.model = meta.model;
  s.engine.version = meta.version;
  s.engine.healthy = true;

  // additive per-rank gauges are summed across label splits; percentage and
  // pool-total gauges take the first series (see README limitations)
  s.requests.running = counter(p, "num_running_reqs");
  s.requests.queued = counter(p, "num_queue_reqs");
  s.requests.paused = counter(p, "num_paused_reqs");

  s.throughput.generationTps = counter(p, "gen_throughput");
  s.tokens.promptTotal = counter(p, "prompt_tokens_total");
  s.tokens.generationTotal = counter(p, "generation_tokens_total");
  s.tokens.cachedTotal = counter(p, "cached_tokens_total");
  s.counts.requestsCompletedTotal = counter(p, "num_requests_total");

  s.cache.kvUsagePct = gauge(p, "full_token_usage");
  s.cache.kvUsedTokens = counter(p, "kv_used_tokens");
  s.cache.kvTotalTokens = gauge(p, "max_total_num_tokens");
  s.cache.hitRate = gauge(p, "cache_hit_rate");
  s.cache.hostUsedTokens = gauge(p, "hicache_host_used_tokens");
  s.cache.hostTotalTokens = gauge(p, "hicache_host_total_tokens");
  s.faults.retractedTotal = counter(p, "num_retracted_reqs");

  s.latency.ttft = histogram(p, "time_to_first_token_seconds");
  s.latency.tpot = histogram(p, "inter_token_latency_seconds");
  s.latency.e2e = histogram(p, "e2e_request_latency_seconds");
  s.latency.queueWait = histogram(p, "queue_time_seconds");

  const mamba = gauge(p, "mamba_usage");
  if (mamba !== null) {
    s.capabilities.mamba = true;
    s.extras["mambaUsage"] = mamba;
  }
  if (s.cache.hostTotalTokens !== null) s.capabilities.hicache = true;

  s.extras["loadBackTokensTotal"] = counter(p, "load_back_tokens_total");
  s.extras["fwdOccupancy"] = gauge(p, "fwd_occupancy");

  if (s.tokens.cachedTotal !== null && s.tokens.promptTotal !== null && s.tokens.promptTotal > 0) {
    s.cache.cumulativeHitRate = Math.min(1, s.tokens.cachedTotal / s.tokens.promptTotal);
    s.capabilities.prefixCache = true;
  }

  return s;
}

async function serverInfo(url: string): Promise<AdapterMeta> {
  const r = await fetchText(`${stripSlashes(url)}/get_server_info`);
  if (!r.ok) return { model: null, version: null };
  try {
    const j = JSON.parse(r.text) as Record<string, unknown>;
    return {
      model: typeof j["model_path"] === "string" ? (j["model_path"] as string) : null,
      version: typeof j["version"] === "string" ? (j["version"] as string) : null,
    };
  } catch {
    return { model: null, version: null };
  }
}

export const sglang: EngineAdapter = {
  id: "sglang",

  async detect(url: string) {
    const r = await fetchText(`${stripSlashes(url)}/get_server_info`);
    if (!r.ok) return null;
    try {
      JSON.parse(r.text);
      return "sglang";
    } catch {
      return null;
    }
  },

  async check(url: string) {
    const r = await fetchText(`${stripSlashes(url)}/health`);
    return r.ok;
  },

  async describe(url: string): Promise<AdapterMeta> {
    return serverInfo(url);
  },

  async sample(url: string, ts: number): Promise<Snapshot> {
    const base = stripSlashes(url);
    const s = emptySnapshot(ts, "sglang");
    const [m, info] = await Promise.all([fetchText(`${base}/metrics`), serverInfo(url)]);
    if (!m.ok) return s;
    s.engine.rttMs = Math.round(m.rttMs * 10) / 10;
    return normalizeSglang(parsePrometheus(m.text), info, ts);
  },
};
