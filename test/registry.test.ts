import { expect, test } from "bun:test";
import { emptySnapshot } from "../src/core/model.ts";
import { Ring, ringCapacity } from "../src/core/registry.ts";

test("Ring enforces capacity FIFO", () => {
  const r = new Ring(3);
  r.push(emptySnapshot(1000));
  r.push(emptySnapshot(2000));
  r.push(emptySnapshot(3000));
  r.push(emptySnapshot(4000));
  expect(r.size).toBe(3);
  expect(r.latest()!.ts).toBe(4000);
  expect(r.all().map((s) => s.ts)).toEqual([2000, 3000, 4000]);
});

test("Ring.latest on empty ring", () => {
  const r = new Ring(10);
  expect(r.latest()).toBeNull();
});

test("Ring.within filters by time window", () => {
  const r = new Ring(10);
  for (const t of [1_000_000, 2_000_000, 3_000_000, 4_000_000]) r.push(emptySnapshot(t));
  // 1500 s window ending at 4_000_000 ms → cutoff 2_500_000
  expect(r.within(1500, 4_000_000).map((s) => s.ts)).toEqual([3_000_000, 4_000_000]);
  expect(r.within(10_000, 4_000_000).map((s) => s.ts)).toEqual([
    1_000_000, 2_000_000, 3_000_000, 4_000_000,
  ]);
});

test("Ring.clear empties the buffer", () => {
  const r = new Ring(10);
  r.push(emptySnapshot(1000));
  r.clear();
  expect(r.size).toBe(0);
});

test("ringCapacity bounds", () => {
  expect(ringCapacity(2)).toBe(450);
  expect(ringCapacity(1)).toBe(900);
  expect(ringCapacity(60)).toBe(60); // clamped to minimum 60
});
