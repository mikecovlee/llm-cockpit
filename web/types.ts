/** Wire types shared between the server API and the UI modules. */

export interface HistBuckets {
  buckets: { upper: number; count: number }[];
  sum: number;
  count: number;
}

export interface Snapshot {
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
    utilization: number | null;
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
    evictedTokensTotal: number | null;
  };
  latency: {
    ttft: HistBuckets | null;
    tpot: HistBuckets | null;
    e2e: HistBuckets | null;
    queueWait: HistBuckets | null;
  };
  faults: {
    retractedTotal: number | null;
    preemptedTotal: number | null;
    abortedTotal: number | null;
  };
  extras: Record<string, number | null>;
  capabilities: Record<string, boolean>;
}

export interface GpuRow {
  index: number;
  name: string;
  utilPct: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  tempC: number | null;
  powerW: number | null;
  powerLimitW: number | null;
}

export interface GpuState {
  available: boolean;
  gpus: GpuRow[];
}

export interface GpuSeries {
  util: (number | null)[];
  mem: (number | null)[];
}

export interface Target {
  id: string;
  url: string;
  adapter: string;
  status: "pending" | "online" | "offline";
  model: string | null;
  version: string | null;
}

/** Wire shape of /api/history?compact=1 — chart scalars only (public API
 * contract mirrored by toChartPoint in src/server.ts). */
export interface ChartPoint {
  ts: number;
  requests: {
    running: number | null;
    queued: number | null;
  };
  throughput: {
    generationTps: number | null;
    prefillTps: number | null;
  };
  cache: {
    kvUsagePct: number | null;
  };
  latency: { ttft: { p50: number | null; p90: number | null; p99: number | null } | null };
}
