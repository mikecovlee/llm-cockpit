import { expect, test } from "bun:test";
import { histogramToQuantiles, quantile, rate } from "../src/core/derive.ts";

const buckets = Array.from({ length: 10 }, (_, i) => ({ upper: i + 1, count: (i + 1) * 10 }));

test("quantile interpolates linearly within the hit bucket", () => {
  expect(quantile(buckets, 100, 0.5)).toBe(5);
  expect(quantile(buckets, 100, 0.99)).toBeCloseTo(9.9, 10);
});

test("quantile handles degenerate inputs", () => {
  expect(quantile([], 100, 0.5)).toBeNull();
  expect(quantile(buckets, 0, 0.5)).toBeNull();
  expect(quantile(buckets, 100, 0)).toBeNull();
  expect(quantile(buckets, 100, 1.5)).toBeNull();
  expect(quantile([{ upper: 2, count: 5 }], 5, 0.99)).toBeCloseTo(1.98, 10);
});

test("histogramToQuantiles on a known distribution", () => {
  const q = histogramToQuantiles({
    buckets: [
      { upper: 10, count: 50 },
      { upper: 20, count: 100 },
    ],
    sum: 1200,
    count: 100,
  });
  expect(q.p50).toBe(10);
  expect(q.p90).toBeCloseTo(18, 10);
  expect(q.p99).toBeCloseTo(19.8, 10);
  expect(q.mean).toBeCloseTo(12, 10);
});

test("histogramToQuantiles with no data", () => {
  expect(histogramToQuantiles(null)).toEqual({ p50: null, p90: null, p99: null, mean: null });
});

test("rate: normal, zero, and counter reset", () => {
  expect(rate(100, 120, 2000)).toBe(10);
  expect(rate(100, 100, 2000)).toBe(0);
  expect(rate(100, 90, 2000)).toBeNull();
  expect(rate(null, 100, 2000)).toBeNull();
  expect(rate(100, null, 2000)).toBeNull();
  expect(rate(100, 120, 0)).toBeNull();
});
