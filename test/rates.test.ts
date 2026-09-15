import { expect, test } from "bun:test";
import { deriveRates } from "../src/core/derive.ts";
import { emptySnapshot, type Snapshot } from "../src/core/model.ts";

function withCounters(ts: number, v: Partial<Record<string, number>>): Snapshot {
  const s = emptySnapshot(ts, "sglang");
  s.counts.requestsCompletedTotal = v.completed ?? null;
  s.throughput.prefillEffectiveTotal = v.prefillEff ?? null;
  s.cache.deviceHitTotal = v.devHit ?? null;
  s.cache.hostHitTotal = v.hostHit ?? null;
  s.cache.storageHitTotal = v.stoHit ?? null;
  if (v.flops !== undefined) s.extras["mfuFlopsTotal"] = v.flops;
  if (v.readB !== undefined) s.extras["mfuReadBytesTotal"] = v.readB;
  if (v.writeB !== undefined) s.extras["mfuWriteBytesTotal"] = v.writeB;
  return s;
}

test("first sample has no derived rates", () => {
  const next = withCounters(1000, { completed: 10, prefillEff: 100, devHit: 50 });
  deriveRates(null, next, 0);
  expect(next.throughput.requestsPerSec).toBeNull();
  expect(next.throughput.prefillEffectiveTps).toBeNull();
  expect(next.cache.deviceHitTps).toBeNull();
});

test("rates derive from deltas over dt", () => {
  const prev = withCounters(1000, {
    completed: 10,
    prefillEff: 1000,
    devHit: 500,
    hostHit: 200,
    stoHit: 0,
    flops: 2e12,
    readB: 3e9,
    writeB: 1e9,
  });
  const next = withCounters(3000, {
    completed: 16,
    prefillEff: 3000,
    devHit: 900,
    hostHit: 300,
    stoHit: 0,
    flops: 6e12,
    readB: 9e9,
    writeB: 3e9,
  });
  deriveRates(prev, next, 2000);
  expect(next.throughput.requestsPerSec).toBeCloseTo(3, 10);
  expect(next.throughput.prefillEffectiveTps).toBeCloseTo(1000, 10);
  expect(next.cache.deviceHitTps).toBeCloseTo(200, 10);
  expect(next.cache.hostHitTps).toBeCloseTo(50, 10);
  expect(next.cache.storageHitTps).toBeCloseTo(0, 10);
  expect(next.extras["tflopsAllGpus"]).toBeCloseTo(2, 10);
  expect(next.extras["memBandwidthGbsAllGpus"]).toBeCloseTo(4, 10);
});

test("counter reset yields null, not negative", () => {
  const prev = withCounters(1000, { completed: 100 });
  const next = withCounters(2000, { completed: 5 });
  deriveRates(prev, next, 1000);
  expect(next.throughput.requestsPerSec).toBeNull();
});
