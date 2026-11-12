/** llama.cpp adapter: /metrics (Prometheus) + /slots + /props. */

import { emptySnapshot, type Snapshot } from "../core/model.ts";
import { findSeries, type Parsed, parsePrometheus, sumSeries } from "../core/prom.ts";
import { fetchText, stripSlashes } from "./http.ts";
import type { AdapterMeta, EngineAdapter } from "./types.ts";

const G = "llamacpp:";

interface SlotInfo {
  n_ctx?: unknown;
  is_processing?: unknown;
}

function gauge(p: Parsed, name: string): number | null {
  const s = findSeries(p, `${G}${name}`);
  return s === null ? null : s.value;
}

function counter(p: Parsed, name: string): number | null {
  return sumSeries(p, `${G}${name}`);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Pure normalization — extracted so unit tests can feed it fixture data.
 * `kvUsedTokens` maps `n_tokens_max` (peak sequence length held by a slot),
 * which is the closest llama.cpp reports to KV occupancy; its idle value
 * reflects the retained slot cache, unlike SGLang's live pool gauge.
 */
export function normalizeLlamacpp(
  p: Parsed,
  slots: SlotInfo[] | null,
  meta: AdapterMeta,
  ts: number,
): Snapshot {
  const s = emptySnapshot(ts, "llamacpp");
  s.engine.model = meta.model;
  s.engine.version = meta.version;
  s.engine.healthy = true;

  s.requests.running = gauge(p, "requests_processing");
  s.requests.queued = gauge(p, "requests_deferred");

  s.throughput.generationTps = gauge(p, "predicted_tokens_seconds");
  s.throughput.prefillTps = gauge(p, "prompt_tokens_seconds");

  s.tokens.promptTotal = counter(p, "prompt_tokens_total");
  s.tokens.generationTotal = counter(p, "tokens_predicted_total");
  s.tokens.cachedTotal = counter(p, "prompt_tokens_cached_total");

  s.cache.kvUsedTokens = gauge(p, "n_tokens_max");
  if (slots !== null) {
    let total = 0;
    for (const slot of slots) {
      const n = num(slot.n_ctx);
      if (n !== null) total += n;
    }
    s.cache.kvTotalTokens = total > 0 ? total : null;
  }
  if (s.cache.kvUsedTokens !== null && s.cache.kvTotalTokens !== null && s.cache.kvTotalTokens > 0) {
    s.cache.kvUsagePct = Math.min(1, s.cache.kvUsedTokens / s.cache.kvTotalTokens);
  }
  s.cache.prefixHitsTotal = counter(p, "prompt_tokens_cached_total");

  const prompt = s.tokens.promptTotal;
  const cached = s.tokens.cachedTotal;
  if (cached !== null && prompt !== null && prompt + cached > 0) {
    s.cache.cumulativeHitRate = Math.min(1, cached / (prompt + cached));
    s.capabilities.prefixCache = true;
  }

  s.extras.specAcceptedTotal = counter(p, "spec_decode_num_accepted_tokens_total");
  s.extras.specDraftsTotal = counter(p, "spec_decode_num_drafts_total");
  s.extras.specDraftTokensTotal = counter(p, "spec_decode_num_draft_tokens_total");

  return s;
}

async function propsMeta(url: string): Promise<{ meta: AdapterMeta; slotsHint: SlotInfo[] | null }> {
  const r = await fetchText(`${stripSlashes(url)}/props`);
  if (!r.ok) return { meta: { model: null, version: null }, slotsHint: null };
  try {
    const j = JSON.parse(r.text) as Record<string, unknown>;
    return {
      meta: {
        model: typeof j["model_alias"] === "string" ? (j["model_alias"] as string)
          : typeof j["model_path"] === "string" ? (j["model_path"] as string) : null,
        version: typeof j["build_info"] === "string" ? (j["build_info"] as string) : null,
      },
      slotsHint: null,
    };
  } catch {
    return { meta: { model: null, version: null }, slotsHint: null };
  }
}

export const llamacpp: EngineAdapter = {
  id: "llamacpp",

  async detect(url: string) {
    const r = await fetchText(`${stripSlashes(url)}/props`);
    if (!r.ok) return null;
    try {
      const j = JSON.parse(r.text) as Record<string, unknown>;
      return typeof j["total_slots"] === "number" && "endpoint_props" in j ? "llamacpp" : null;
    } catch {
      return null;
    }
  },

  async check(url: string) {
    const r = await fetchText(`${stripSlashes(url)}/health`);
    return r.ok;
  },

  async describe(url: string): Promise<AdapterMeta> {
    return (await propsMeta(url)).meta;
  },

  async sample(url: string, ts: number): Promise<Snapshot> {
    const base = stripSlashes(url);
    const s = emptySnapshot(ts, "llamacpp");
    const [m, sl, pr] = await Promise.all([
      fetchText(`${base}/metrics`),
      fetchText(`${base}/slots`),
      propsMeta(url),
    ]);
    if (!m.ok) return s;
    s.engine.rttMs = Math.round(m.rttMs * 10) / 10;
    let slots: SlotInfo[] | null = null;
    if (sl.ok) {
      try {
        const parsed: unknown = JSON.parse(sl.text);
        if (Array.isArray(parsed)) slots = parsed as SlotInfo[];
      } catch {
        slots = null;
      }
    }
    return normalizeLlamacpp(parsePrometheus(m.text), slots, pr.meta, ts);
  },
};
