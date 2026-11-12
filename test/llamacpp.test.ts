import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { normalizeLlamacpp } from "../src/adapters/llamacpp.ts";
import { parsePrometheus } from "../src/core/prom.ts";

const p = parsePrometheus(readFileSync("test/fixtures/llamacpp/metrics.txt", "utf8"));
const slots = JSON.parse(readFileSync("test/fixtures/llamacpp/slots.json", "utf8")) as {
  n_ctx?: unknown;
}[];
const props = JSON.parse(readFileSync("test/fixtures/llamacpp/props.json", "utf8")) as Record<
  string,
  unknown
>;
const meta = {
  model: typeof props["model_alias"] === "string" ? (props["model_alias"] as string) : null,
  version: typeof props["build_info"] === "string" ? (props["build_info"] as string) : null,
};

const s = normalizeLlamacpp(p, slots, meta, 1700000000000);

test("engine meta from /props", () => {
  expect(s.engine.adapter).toBe("llamacpp");
  expect(s.engine.healthy).toBe(true);
  expect(s.engine.model).toBe("qwen3.8-27b");
  expect(s.engine.version).toContain("b12302");
});

test("requests & throughput gauges", () => {
  expect(typeof s.requests.running).toBe("number");
  expect(typeof s.requests.queued).toBe("number");
  expect(typeof s.throughput.generationTps).toBe("number");
  expect(typeof s.throughput.prefillTps).toBe("number");
});

test("token counters", () => {
  expect(typeof s.tokens.promptTotal).toBe("number");
  expect(typeof s.tokens.generationTotal).toBe("number");
  expect(typeof s.tokens.cachedTotal).toBe("number");
  expect(s.counts.requestsCompletedTotal).toBeNull();
});

test("KV cache from n_tokens_max + slot n_ctx", () => {
  expect(s.cache.kvUsedTokens).not.toBeNull();
  expect(s.cache.kvTotalTokens).toBe(262144);
  expect(s.cache.kvUsagePct).not.toBeNull();
  expect(s.cache.kvUsagePct!).toBeLessThanOrEqual(1);
});

test("prefix cache capability + spec decode extras", () => {
  expect(s.capabilities.prefixCache).toBe(true);
  expect(typeof s.cache.cumulativeHitRate).toBe("number");
  expect(s.extras.specAcceptedTotal).not.toBeNull();
  expect(s.extras.specDraftTokensTotal).not.toBeNull();
});

test("slots-less normalization keeps nulls", () => {
  const bare = normalizeLlamacpp(p, null, meta, 1700000000000);
  expect(bare.cache.kvTotalTokens).toBeNull();
  expect(bare.cache.kvUsagePct).toBeNull();
});
