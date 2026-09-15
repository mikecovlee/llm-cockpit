import { expect, test } from "bun:test";
import { normalizeSglang } from "../src/adapters/sglang.ts";
import { normalizeVllm } from "../src/adapters/vllm.ts";
import { parsePrometheus, sumSeries } from "../src/core/prom.ts";

test("sumSeries aggregates every series sharing a metric name", () => {
  const p = parsePrometheus('x_total{a="1"} 2\nx_total{a="2"} 3\ny_total 7\n');
  expect(sumSeries(p, "x_total")).toBe(5);
  expect(sumSeries(p, "y_total")).toBe(7);
  expect(sumSeries(p, "missing_total")).toBeNull();
});

const sglangSplit = [
  'sglang:prompt_tokens_total{engine_type="unified",is_streaming="false"} 429',
  'sglang:prompt_tokens_total{engine_type="unified",is_streaming="true"} 61824949',
  'sglang:generation_tokens_total{is_streaming="false"} 177',
  'sglang:generation_tokens_total{is_streaming="true"} 492421',
  'sglang:cached_tokens_total{cache_source="device"} 49162624',
  'sglang:cached_tokens_total{cache_source="host"} 7406912',
  'sglang:num_requests_total{is_streaming="false"} 4',
  'sglang:num_requests_total{is_streaming="true"} 421',
].join("\n");

test("sglang counters split by labels are summed, not first-series", () => {
  const s = normalizeSglang(parsePrometheus(sglangSplit), { model: null, version: null }, 1);
  expect(s.tokens.promptTotal).toBe(429 + 61824949);
  expect(s.tokens.generationTotal).toBe(177 + 492421);
  expect(s.tokens.cachedTotal).toBe(49162624 + 7406912);
  expect(s.counts.requestsCompletedTotal).toBe(4 + 421);
});

test("sglang derives cumulative cache hit rate from counters", () => {
  const s = normalizeSglang(parsePrometheus(sglangSplit), { model: null, version: null }, 1);
  expect(s.cache.rollingHitRate).toBeCloseTo((49162624 + 7406912) / (429 + 61824949), 9);
});

test("vllm label-split counters are summed", () => {
  const p = parsePrometheus(
    [
      'vllm:prompt_tokens_total{model_name="a"} 100',
      'vllm:prompt_tokens_total{model_name="b"} 2300',
      'vllm:prefix_cache_hits_total{model_name="a"} 40',
      'vllm:prefix_cache_queries_total{model_name="a"} 80',
    ].join("\n"),
  );
  const s = normalizeVllm(p, { model: null, version: null }, 1);
  expect(s.tokens.promptTotal).toBe(2400);
  expect(s.cache.prefixHitsTotal).toBe(40);
  expect(s.cache.prefixQueriesTotal).toBe(80);
});
