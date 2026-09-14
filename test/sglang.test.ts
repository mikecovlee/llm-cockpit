import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { normalizeSglang } from "../src/adapters/sglang.ts";
import { parsePrometheus } from "../src/core/prom.ts";

const p = parsePrometheus(readFileSync("test/fixtures/sglang/metrics.txt", "utf8"));
const info = JSON.parse(readFileSync("test/fixtures/sglang/server_info.json", "utf8")) as Record<
  string,
  unknown
>;
const meta = {
  model: typeof info["model_path"] === "string" ? (info["model_path"] as string) : null,
  version: typeof info["version"] === "string" ? (info["version"] as string) : null,
};

const s = normalizeSglang(p, meta, 1700000000000);

test("engine meta from /get_server_info", () => {
  expect(s.engine.adapter).toBe("sglang");
  expect(s.engine.healthy).toBe(true);
  expect(s.engine.model).toBe("/models/Qwen3.8-27B-NVFP4");
  expect(s.engine.version).toBe("0.5.19");
});

test("requests & throughput normalized", () => {
  expect(s.requests.running).toBeGreaterThanOrEqual(0);
  expect(typeof s.requests.queued).toBe("number");
  expect(s.throughput.generationTps).toBeGreaterThanOrEqual(0);
});

test("token counters + completed count", () => {
  expect(s.tokens.promptTotal).toBeGreaterThan(0);
  expect(s.tokens.generationTotal).toBeGreaterThanOrEqual(0);
  expect(s.tokens.cachedTotal).toBeGreaterThanOrEqual(0);
  expect(s.counts.requestsCompletedTotal).toBeGreaterThanOrEqual(0);
});

test("KV cache + hicache tier normalized", () => {
  expect(s.cache.kvUsedTokens).not.toBeNull();
  expect(s.cache.kvTotalTokens).not.toBeNull();
  expect(s.cache.kvUsagePct).not.toBeNull();
  expect(s.cache.hostUsedTokens).not.toBeNull();
  expect(s.cache.hostTotalTokens).not.toBeNull();
  expect(s.capabilities.hicache).toBe(true);
});

test("fault counters + mamba capability + extras", () => {
  expect(s.faults.retractedTotal).not.toBeNull();
  expect(s.capabilities.mamba).toBe(true);
  expect(s.extras["mambaUsage"]).not.toBeNull();
});

test("latency histograms present with counts", () => {
  expect(s.latency.ttft).not.toBeNull();
  expect(s.latency.e2e).not.toBeNull();
  expect(s.latency.ttft!.count).toBeGreaterThan(0);
  expect(s.latency.ttft!.sum).toBeGreaterThan(0);
});
