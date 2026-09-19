/**
 * Custom (declarative) adapter: map canonical fields to Prometheus metric
 * names or JSON paths, without writing any code. Validated at config load
 * time and by POST /api/validate-mapping.
 */

import { emptySnapshot, type HistogramBuckets, type Snapshot } from "../core/model.ts";
import { findHistogram, findSeries, type Parsed, parsePrometheus } from "../core/prom.ts";
import { fetchText, stripSlashes } from "./http.ts";
import type { AdapterMeta, EngineAdapter } from "./types.ts";

export interface CustomAdapterSpec {
  id: string;
  source: "prometheus" | "json";
  /** Data endpoint; defaults to <target>/metrics (prometheus) or the target url (json). */
  url?: string;
  /** Health endpoint; defaults to the data endpoint. */
  health?: string;
  /** canonical dotted field -> metric name (prometheus) or JSON path (json). */
  mapping: Record<string, string>;
  /** Static values, e.g. { "engine.model": "my-model", "engine.version": "1.0" }. */
  static?: Record<string, string>;
}

const FIELD_GROUPS: Record<string, string[]> = {
  requests: ["running", "queued", "utilization"],
  throughput: ["generationTps", "prefillTps", "requestsPerSec"],
  tokens: ["promptTotal", "generationTotal", "cachedTotal"],
  counts: ["requestsCompletedTotal"],
  cache: [
    "kvUsagePct",
    "kvUsedTokens",
    "kvTotalTokens",
    "hitRate",
    "prefixHitsTotal",
    "prefixQueriesTotal",
    "cumulativeHitRate",
    "evictedTokensTotal",
  ],
  faults: ["retractedTotal", "preemptedTotal", "abortedTotal"],
  latency: ["ttft", "tpot", "e2e", "queueWait"],
};

export function validateMappingField(field: string): boolean {
  if (field.startsWith("extras.")) return field.length > "extras.".length;
  const dot = field.indexOf(".");
  if (dot <= 0) return false;
  const group = field.slice(0, dot);
  const key = field.slice(dot + 1);
  const keys = FIELD_GROUPS[group];
  return keys !== undefined && keys.includes(key);
}

export function validateCustomSpec(spec: CustomAdapterSpec): string[] {
  const errors: string[] = [];
  if (typeof spec?.id !== "string" || spec.id === "") errors.push("id: required non-empty string");
  if (spec.source !== "prometheus" && spec.source !== "json") {
    errors.push(`source: must be 'prometheus' or 'json' (got ${String(spec.source)})`);
  }
  if (spec.mapping === undefined || spec.mapping === null || typeof spec.mapping !== "object") {
    errors.push("mapping: required object");
    return errors;
  }
  for (const [field, target] of Object.entries(spec.mapping)) {
    if (!validateMappingField(field)) errors.push(`mapping: unknown canonical field '${field}'`);
    if (typeof target !== "string" || target === "") {
      errors.push(`mapping['${field}']: must be a non-empty string`);
    }
  }
  return errors;
}

function isNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Minimal JSON path resolver. Supports dot paths (`$.a.b`), integer segments
 * for array indices (`$.gpu.0.util`) and bracket indices (`$.gpu[0].util`,
 * `$.gpu[0][1]`). Anything else resolves to null.
 */
export function resolveJsonPath(data: unknown, path: string): number | null {
  const p = path.replace(/^\$\.?/, "");
  let cur: unknown = data;
  if (p === "") return isNum(cur);
  for (const seg of p.split(".").filter((x) => x !== "")) {
    if (cur === null || typeof cur !== "object") return null;
    const km = /^([^[\]]*)((?:\[\d+\])*)$/.exec(seg);
    if (km === null) return null;
    const key = km[1]!;
    const idxStrs = (km[2] ?? "").match(/\[\d+\]/g) ?? [];
    if (key !== "") {
      if (Array.isArray(cur) && /^\d+$/.test(key) && idxStrs.length === 0) {
        const idx = Number(key);
        if (idx < 0 || idx >= cur.length) return null;
        cur = cur[idx];
      } else {
        const rec = cur as Record<string, unknown>;
        if (!(key in rec)) return null;
        cur = rec[key];
      }
    }
    for (const raw of idxStrs) {
      if (!Array.isArray(cur)) return null;
      const idx = Number(raw.slice(1, -1));
      if (idx < 0 || idx >= cur.length) return null;
      cur = cur[idx];
    }
  }
  return isNum(cur);
}

const LATENCY_KEYS = ["ttft", "tpot", "e2e", "queueWait"] as const;

function hist(p: Parsed, name: string): HistogramBuckets | null {
  const h = findHistogram(p, name);
  if (h === null) return null;
  return { buckets: h.buckets, sum: h.sum, count: h.count };
}

/** Pure normalization — extracted so unit tests can feed it fixture data. */
export function normalizeCustom(
  p: Parsed | null,
  json: unknown,
  spec: CustomAdapterSpec,
  ts: number,
): Snapshot {
  const s = emptySnapshot(ts, spec.id);
  s.engine.healthy = true;
  if (spec.static !== undefined) {
    s.engine.model = spec.static["engine.model"] ?? null;
    s.engine.version = spec.static["engine.version"] ?? null;
  }

  for (const [field, target] of Object.entries(spec.mapping)) {
    if (field.startsWith("latency.")) {
      // Latency fields map to a Prometheus histogram base name.
      if (spec.source === "prometheus" && p !== null) {
        const key = field.slice("latency.".length);
        if ((LATENCY_KEYS as readonly string[]).includes(key)) {
          s.latency[key as (typeof LATENCY_KEYS)[number]] = hist(p, target);
        }
      }
      continue;
    }

    const v =
      spec.source === "prometheus" && p !== null
        ? (findSeries(p, target)?.value ?? null)
        : resolveJsonPath(json, target);

    if (field.startsWith("requests.")) {
      s.requests[field.slice("requests.".length) as keyof Snapshot["requests"]] = v;
    } else if (field.startsWith("throughput.")) {
      s.throughput[field.slice("throughput.".length) as keyof Snapshot["throughput"]] = v;
    } else if (field.startsWith("tokens.")) {
      s.tokens[field.slice("tokens.".length) as keyof Snapshot["tokens"]] = v;
    } else if (field.startsWith("counts.")) {
      s.counts[field.slice("counts.".length) as keyof Snapshot["counts"]] = v;
    } else if (field.startsWith("cache.")) {
      s.cache[field.slice("cache.".length) as keyof Snapshot["cache"]] = v;
    } else if (field.startsWith("faults.")) {
      s.faults[field.slice("faults.".length) as keyof Snapshot["faults"]] = v;
    } else if (field.startsWith("extras.")) {
      s.extras[field.slice("extras.".length)] = v;
    }
  }

  if (s.cache.prefixHitsTotal !== null) s.capabilities.prefixCache = true;
  return s;
}

export function createCustomAdapter(spec: CustomAdapterSpec): EngineAdapter {
  const dataUrl = (targetUrl: string): string =>
    spec.url ?? (spec.source === "json" ? targetUrl : `${stripSlashes(targetUrl)}/metrics`);

  return {
    id: spec.id,

    async detect(): Promise<string | null> {
      return null; // custom adapters are always explicitly configured
    },

    async check(url: string): Promise<boolean> {
      const r = await fetchText(spec.health ?? dataUrl(url));
      return r.ok;
    },

    async describe(): Promise<AdapterMeta> {
      return {
        model: spec.static?.["engine.model"] ?? null,
        version: spec.static?.["engine.version"] ?? null,
      };
    },

    async sample(url: string, ts: number): Promise<Snapshot> {
      const s = emptySnapshot(ts, spec.id);
      if (spec.static !== undefined) {
        s.engine.model = spec.static["engine.model"] ?? null;
        s.engine.version = spec.static["engine.version"] ?? null;
      }
      const r = await fetchText(dataUrl(url));
      if (!r.ok) return s;
      s.engine.rttMs = Math.round(r.rttMs * 10) / 10;
      if (spec.source === "prometheus") {
        return normalizeCustom(parsePrometheus(r.text), null, spec, ts);
      }
      try {
        return normalizeCustom(null, JSON.parse(r.text) as unknown, spec, ts);
      } catch {
        return s;
      }
    },
  };
}
