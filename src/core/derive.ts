/** Derivation helpers: quantiles from histogram buckets, counter rates. */

import type { HistogramBuckets, Snapshot } from "./model.ts";

/**
 * Linear-interpolated quantile over cumulative histogram buckets.
 * `buckets` must be sorted ascending by `upper`; `total` is the +Inf count.
 */
export function quantile(
  buckets: { upper: number; count: number }[],
  total: number,
  q: number,
): number | null {
  if (!(total > 0) || !(q > 0 && q <= 1) || buckets.length === 0) return null;
  const target = q * total;
  let prevCount = 0;
  let prevUpper = 0;
  for (const b of buckets) {
    if (b.count >= target) {
      const width = b.count - prevCount;
      if (width <= 0) return b.upper;
      const frac = (target - prevCount) / width;
      return prevUpper + (b.upper - prevUpper) * frac;
    }
    prevCount = b.count;
    prevUpper = b.upper;
  }
  const last = buckets[buckets.length - 1]!;
  return last.upper;
}

export interface LatencyQuantiles {
  p50: number | null;
  p90: number | null;
  p99: number | null;
  mean: number | null;
}

export function histogramToQuantiles(h: HistogramBuckets | null): LatencyQuantiles {
  if (h === null || h.count <= 0) {
    return { p50: null, p90: null, p99: null, mean: null };
  }
  return {
    p50: quantile(h.buckets, h.count, 0.5),
    p90: quantile(h.buckets, h.count, 0.9),
    p99: quantile(h.buckets, h.count, 0.99),
    mean: h.count > 0 ? h.sum / h.count : null,
  };
}

/**
 * Per-second rate of a monotonically increasing counter.
 * Returns null when inputs are missing or when the counter appears to have
 * reset (now < prev) — callers should treat null as "unknown", not zero.
 */
export function rate(prev: number | null, now: number | null, dtMs: number): number | null {
  if (prev === null || now === null || dtMs <= 0) return null;
  const r = (now - prev) / (dtMs / 1000);
  if (!Number.isFinite(r) || r < 0) return null;
  return r;
}

/**
 * Fill derived per-second fields on `next` from the previous sample.
 * Called by the poll loop before the snapshot enters the ring; with no
 * previous sample every derived field stays null (first paint shows gauges
 * only, rates appear from the second poll).
 */
export function deriveRates(prev: Snapshot | null, next: Snapshot, dtMs: number): void {
  if (prev === null) return;
  const r = (p: number | null, n: number | null): number | null => rate(p, n, dtMs);
  next.throughput.requestsPerSec = r(
    prev.counts.requestsCompletedTotal,
    next.counts.requestsCompletedTotal,
  );
}
