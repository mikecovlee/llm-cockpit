/**
 * Canonical, engine-agnostic snapshot model.
 * Every adapter (sglang / vllm / custom) normalizes its engine's raw metrics
 * into this shape, so the UI only ever consumes one schema.
 * All fields are nullable: a capability the engine does not expose stays null,
 * and the UI renders only what is present (driven by `capabilities`).
 */

export interface HistogramBuckets {
  /** Finite buckets, sorted ascending by `upper`. The +Inf bucket is stripped. */
  buckets: { upper: number; count: number }[];
  sum: number;
  count: number;
}

export interface SnapshotEngine {
  adapter: string;
  model: string | null;
  version: string | null;
  healthy: boolean;
  rttMs: number;
}

export interface SnapshotRequests {
  running: number | null;
  queued: number | null;
  swapped: number | null;
  paused: number | null;
}

export interface SnapshotThroughput {
  generationTps: number | null;
  prefillTps: number | null;
  requestsPerSec: number | null;
  /** Cumulative effective prefill tokens (all sources). */
  prefillEffectiveTotal: number | null;
  /** Derived from prefillEffectiveTotal between consecutive samples. */
  prefillEffectiveTps: number | null;
}

export interface SnapshotTokens {
  promptTotal: number | null;
  generationTotal: number | null;
  cachedTotal: number | null;
}

export interface SnapshotCounts {
  requestsCompletedTotal: number | null;
}

export interface SnapshotCache {
  kvUsagePct: number | null;
  kvUsedTokens: number | null;
  kvTotalTokens: number | null;
  /** Engine-reported cache hit rate in [0,1] when available. */
  hitRate: number | null;
  prefixHitsTotal: number | null;
  prefixQueriesTotal: number | null;
  /** Cumulative hit ratio derived from engine counters (all-time). */
  cumulativeHitRate: number | null;
  /** Host-tier (L2, e.g. SGLang hicache) usage. */
  hostUsedTokens: number | null;
  hostTotalTokens: number | null;
  kvAvailableTokens: number | null;
  /** Cumulative prefill tokens served from each cache tier (sglang mode split). */
  deviceHitTotal: number | null;
  hostHitTotal: number | null;
  storageHitTotal: number | null;
  /** Derived per-sample rates of the tier totals. */
  deviceHitTps: number | null;
  hostHitTps: number | null;
  storageHitTps: number | null;
}

export interface SnapshotLatency {
  ttft: HistogramBuckets | null;
  tpot: HistogramBuckets | null;
  e2e: HistogramBuckets | null;
  queueWait: HistogramBuckets | null;
}

export interface SnapshotFaults {
  retractedTotal: number | null;
  preemptedTotal: number | null;
}

export interface Capabilities {
  mamba: boolean;
  hicache: boolean;
  prefixCache: boolean;
  specDecode: boolean;
}

export interface Snapshot {
  /** epoch ms */
  ts: number;
  engine: SnapshotEngine;
  requests: SnapshotRequests;
  throughput: SnapshotThroughput;
  tokens: SnapshotTokens;
  counts: SnapshotCounts;
  cache: SnapshotCache;
  latency: SnapshotLatency;
  faults: SnapshotFaults;
  /** Free-form engine-specific pass-through values. */
  extras: Record<string, number | null>;
  capabilities: Capabilities;
}

export function emptySnapshot(ts = Date.now(), adapter = "unknown"): Snapshot {
  return {
    ts,
    engine: { adapter, model: null, version: null, healthy: false, rttMs: 0 },
    requests: { running: null, queued: null, swapped: null, paused: null },
    throughput: {
      generationTps: null,
      prefillTps: null,
      requestsPerSec: null,
      prefillEffectiveTotal: null,
      prefillEffectiveTps: null,
    },
    tokens: { promptTotal: null, generationTotal: null, cachedTotal: null },
    counts: { requestsCompletedTotal: null },
    cache: {
      kvUsagePct: null,
      kvUsedTokens: null,
      kvTotalTokens: null,
      hitRate: null,
      prefixHitsTotal: null,
      prefixQueriesTotal: null,
      cumulativeHitRate: null,
      hostUsedTokens: null,
      hostTotalTokens: null,
      kvAvailableTokens: null,
      deviceHitTotal: null,
      hostHitTotal: null,
      storageHitTotal: null,
      deviceHitTps: null,
      hostHitTps: null,
      storageHitTps: null,
    },
    latency: { ttft: null, tpot: null, e2e: null, queueWait: null },
    faults: { retractedTotal: null, preemptedTotal: null },
    extras: {},
    capabilities: { mamba: false, hicache: false, prefixCache: false, specDecode: false },
  };
}
