import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { findHistogram, findSeries, parsePrometheus } from "../src/core/prom.ts";

const fixture = readFileSync("test/fixtures/sglang/metrics.txt", "utf8");
const p = parsePrometheus(fixture);

test("parses the live SGLang fixture: core series present", () => {
  for (const name of [
    "sglang:num_running_reqs",
    "sglang:num_queue_reqs",
    "sglang:num_paused_reqs",
    "sglang:gen_throughput",
    "sglang:full_token_usage",
    "sglang:kv_used_tokens",
    "sglang:max_total_num_tokens",
    "sglang:cache_hit_rate",
    "sglang:prompt_tokens_total",
    "sglang:generation_tokens_total",
    "sglang:cached_tokens_total",
    "sglang:num_requests_total",
  ]) {
    expect(findSeries(p, name), `${name} missing`).not.toBeNull();
  }
});

test("parses the live SGLang fixture: hicache + mamba + faults", () => {
  expect(findSeries(p, "sglang:hicache_host_used_tokens")).not.toBeNull();
  expect(findSeries(p, "sglang:hicache_host_total_tokens")).not.toBeNull();
  expect(findSeries(p, "sglang:mamba_usage")).not.toBeNull();
  expect(findSeries(p, "sglang:num_retracted_reqs")).not.toBeNull();
  expect(findSeries(p, "sglang:load_back_tokens_total")).not.toBeNull();
});

test("histogram: buckets cumulative, sorted, +Inf stripped", () => {
  const h = findHistogram(p, "sglang:time_to_first_token_seconds");
  expect(h, "TTFT histogram missing").not.toBeNull();
  const hh = h!;
  expect(hh.count).toBeGreaterThan(0);
  expect(hh.buckets.length).toBeGreaterThan(1);
  for (let i = 1; i < hh.buckets.length; i++) {
    const cur = hh.buckets[i]!;
    const prev = hh.buckets[i - 1]!;
    expect(cur.upper, "upper ascending").toBeGreaterThan(prev.upper);
    expect(cur.count, "counts cumulative").toBeGreaterThanOrEqual(prev.count);
  }
  for (const b of hh.buckets) expect(Number.isFinite(b.upper)).toBe(true);
});

test("histogram sum/count joined to the right series", () => {
  const h = findHistogram(p, "sglang:time_to_first_token_seconds")!;
  expect(h.sum).toBeGreaterThan(0);
  expect(h.count).toBeGreaterThan(0);
  // count must equal the largest finite cumulative bucket (or be >= it)
  const lastBucket = h.buckets[h.buckets.length - 1]!;
  expect(h.count).toBeGreaterThanOrEqual(lastBucket.count);
});

test("labels parsed, values numeric", () => {
  const s = findSeries(p, "sglang:num_running_reqs")!;
  expect(typeof s.value).toBe("number");
  expect(Number.isFinite(s.value)).toBe(true);
  expect(s.value).toBeGreaterThanOrEqual(0);
});

test("synthetic: NaN, escaped labels, counter/gauge split, histogram assembly", () => {
  const text = [
    "# HELP a help a",
    "# TYPE a gauge",
    "a NaN",
    "# TYPE b counter",
    'b{l="x\\"y"} +Inf',
    "# TYPE c histogram",
    'c_bucket{le="1"} 5',
    'c_bucket{le="5"} 9',
    'c_bucket{le="+Inf"} 10',
    "c_sum 21",
    "c_count 10",
  ].join("\n");
  const q = parsePrometheus(text);
  expect(q.gauges[0]?.value).toBeNaN();
  expect(q.counters[0]?.labels["l"]).toBe('x"y');
  expect(q.counters[0]?.value).toBe(Number.POSITIVE_INFINITY);
  const h = q.histograms.find((x) => x.name === "c");
  expect(h, "histogram c missing").toBeDefined();
  expect(h!.buckets.map((b) => b.upper)).toEqual([1, 5]);
  expect(h!.count).toBe(10);
  expect(h!.sum).toBe(21);
});

test("synthetic: multiple label series stay distinct", () => {
  const text = [
    "# TYPE m histogram",
    'm_bucket{le="+Inf",engine="a"} 1',
    'm_bucket{le="+Inf",engine="b"} 2',
    'm_count{engine="a"} 1',
    'm_count{engine="b"} 2',
  ].join("\n");
  const q = parsePrometheus(text);
  expect(q.histograms).toHaveLength(2);
  const a = findHistogram(q, "m", { engine: "a" })!;
  const b = findHistogram(q, "m", { engine: "b" })!;
  expect(a.count).toBe(1);
  expect(b.count).toBe(2);
});
