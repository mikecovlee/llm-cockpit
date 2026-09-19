import { expect, test } from "bun:test";
import { deriveRates } from "../src/core/derive.ts";
import { emptySnapshot, type Snapshot } from "../src/core/model.ts";

function withCompleted(ts: number, completed: number | null): Snapshot {
  const s = emptySnapshot(ts, "sglang");
  s.counts.requestsCompletedTotal = completed;
  return s;
}

test("first sample has no derived rates", () => {
  const next = withCompleted(1000, 10);
  deriveRates(null, next, 0);
  expect(next.throughput.requestsPerSec).toBeNull();
});

test("rates derive from deltas over dt", () => {
  const prev = withCompleted(1000, 10);
  const next = withCompleted(3000, 16);
  deriveRates(prev, next, 2000);
  expect(next.throughput.requestsPerSec).toBeCloseTo(3, 10);
});

test("counter reset yields null, not negative", () => {
  const prev = withCompleted(1000, 100);
  const next = withCompleted(2000, 5);
  deriveRates(prev, next, 1000);
  expect(next.throughput.requestsPerSec).toBeNull();
});
