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
  /** Scheduler busy ratio in [0,1] when the engine reports one. */
  utilization: number | null;
}

export interface SnapshotThroughput {
  generationTps: number | null;
  prefillTps: number | null;
  requestsPerSec: number | null;
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
  /** Cumulative tokens evicted from the prefix cache. */
  evictedTokensTotal: number | null;
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
  abortedTotal: number | null;
}

export interface Capabilities {
  prefixCache: boolean;
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
    requests: { running: null, queued: null, utilization: null },
    throughput: {
      generationTps: null,
      prefillTps: null,
      requestsPerSec: null,
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
      evictedTokensTotal: null,
    },
    latency: { ttft: null, tpot: null, e2e: null, queueWait: null },
    faults: { retractedTotal: null, preemptedTotal: null, abortedTotal: null },
    extras: {},
    capabilities: { prefixCache: false },
  };
}
