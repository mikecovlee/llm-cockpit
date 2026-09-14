import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type CustomAdapterSpec,
  normalizeCustom,
  resolveJsonPath,
  validateCustomSpec,
  validateMappingField,
} from "../src/adapters/custom.ts";
import { parsePrometheus } from "../src/core/prom.ts";

const promSpec: CustomAdapterSpec = {
  id: "my-engine",
  source: "prometheus",
  mapping: {
    "requests.running": "myengine_running",
    "requests.queued": "myengine_waiting",
    "cache.kvUsagePct": "myengine_kv_usage",
    "counts.requestsCompletedTotal": "myengine_completed",
    "extras.custom": "myengine_extra",
    "latency.ttft": "myengine_ttft",
  },
  static: { "engine.model": "demo-model", "engine.version": "9.9" },
};

test("custom prometheus mapping normalizes", () => {
  const p = parsePrometheus(readFileSync("test/fixtures/custom/metrics.txt", "utf8"));
  const s = normalizeCustom(p, null, promSpec, 1);
  expect(s.engine.adapter).toBe("my-engine");
  expect(s.engine.healthy).toBe(true);
  expect(s.engine.model).toBe("demo-model");
  expect(s.engine.version).toBe("9.9");
  expect(s.requests.running).toBe(7);
  expect(s.requests.queued).toBe(2);
  expect(s.cache.kvUsagePct).toBe(0.35);
  expect(s.counts.requestsCompletedTotal).toBe(42);
  expect(s.extras["custom"]).toBe(1.5);
  expect(s.latency.ttft).not.toBeNull();
  expect(s.latency.ttft!.count).toBe(40);
});

test("custom json mapping normalizes", () => {
  const json = JSON.parse(readFileSync("test/fixtures/custom/json.json", "utf8")) as unknown;
  const spec: CustomAdapterSpec = {
    id: "json-engine",
    source: "json",
    mapping: {
      "requests.running": "$.queue.depth",
      "cache.kvUsagePct": "$.gpu[0].util",
      "tokens.generationTotal": "$.tokens.served",
      "extras.gpu1util": "$.gpu[1].util",
    },
  };
  const s = normalizeCustom(null, json, spec, 1);
  expect(s.requests.running).toBe(3);
  expect(s.cache.kvUsagePct).toBe(0.81);
  expect(s.tokens.generationTotal).toBe(12345);
  expect(s.extras["gpu1util"]).toBe(0.77);
  expect(s.engine.model).toBeNull();
});

test("resolveJsonPath handles misses gracefully", () => {
  const json = { a: { b: [1, 2, 3] } } as unknown;
  expect(resolveJsonPath(json, "$.a.b.1")).toBe(2);
  expect(resolveJsonPath(json, "$.a.b.9")).toBeNull();
  expect(resolveJsonPath(json, "$.a.x")).toBeNull();
  expect(resolveJsonPath(null, "$.a")).toBeNull();
  expect(resolveJsonPath({ a: "str" }, "$.a")).toBeNull();
});

test("validateCustomSpec catches bad fields", () => {
  expect(validateCustomSpec(promSpec)).toEqual([]);
  const bad: CustomAdapterSpec = {
    id: "x",
    source: "prometheus",
    mapping: { "nope.field": "m", latency: "m", "requests.running": "" },
  };
  const errs = validateCustomSpec(bad);
  expect(errs.length).toBeGreaterThanOrEqual(3);
  expect(errs.some((e) => e.includes("nope.field"))).toBe(true);
  expect(errs.some((e) => e.includes("latency"))).toBe(true);
  expect(errs.some((e) => e.includes("requests.running"))).toBe(true);
});

test("validateMappingField accepts extras.* and known fields", () => {
  expect(validateMappingField("requests.running")).toBe(true);
  expect(validateMappingField("extras.anything")).toBe(true);
  expect(validateMappingField("extras.")).toBe(false);
  expect(validateMappingField("requests.nope")).toBe(false);
  expect(validateMappingField("requests")).toBe(false);
});
