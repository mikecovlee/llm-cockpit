import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { normalizeVllm } from "../src/adapters/vllm.ts";
import { parsePrometheus } from "../src/core/prom.ts";

const p = parsePrometheus(readFileSync("test/fixtures/vllm/metrics.txt", "utf8"));
const version = JSON.parse(readFileSync("test/fixtures/vllm/version.json", "utf8")) as {
  version: string;
};

const s = normalizeVllm(p, { model: "test-model", version: version.version }, 1700000000000);

test("vllm core gauges", () => {
  expect(s.engine.adapter).toBe("vllm");
  expect(s.engine.healthy).toBe(true);
  expect(s.requests.running).toBe(3);
  expect(s.requests.queued).toBe(1);
  expect(s.requests.swapped).toBe(0);
  expect(s.faults.preemptedTotal).toBe(2);
});

test("vllm kv cache + prefix cache", () => {
  expect(s.cache.kvUsagePct).toBe(0.42);
  expect(s.cache.prefixHitsTotal).toBe(500);
  expect(s.cache.prefixQueriesTotal).toBe(1000);
  expect(s.cache.cumulativeHitRate).toBeCloseTo(0.5, 10);
  expect(s.capabilities.prefixCache).toBe(true);
});

test("vllm token counters + throughput", () => {
  expect(s.tokens.promptTotal).toBe(20000);
  expect(s.tokens.generationTotal).toBe(5000);
  expect(s.counts.requestsCompletedTotal).toBe(120);
  expect(s.throughput.generationTps).toBe(45.5);
  expect(s.throughput.prefillTps).toBe(1200);
});

test("vllm latency histograms", () => {
  expect(s.latency.ttft!.count).toBe(100);
  expect(s.latency.ttft!.sum).toBe(35);
  expect(s.latency.e2e!.count).toBe(100);
  expect(s.latency.tpot!.count).toBe(100);
  expect(s.latency.queueWait!.count).toBe(100);
  expect(s.engine.model).toBe("test-model");
  expect(s.engine.version).toBe("0.6.4");
});
