import { expect, test } from "bun:test";
import { pickProvider, publicProviders, resolveChatProviders } from "../src/chat/providers.ts";

test("no providers config derives local from first target (+ /v1, slash-tolerant)", () => {
  const a = resolveChatProviders(undefined, "http://127.0.0.1:8080");
  expect(a.errors).toEqual([]);
  expect(a.list.length).toBe(1);
  expect(a.list[0]!.id).toBe("local");
  expect(a.list[0]!.cfg.baseUrl).toBe("http://127.0.0.1:8080/v1");
  expect(a.list[0]!.isDefault).toBe(true);
  const b = resolveChatProviders([], "http://engine:8080/");
  expect(b.list[0]!.cfg.baseUrl).toBe("http://engine:8080/v1");
});

test("first entry is default; explicit default:true overrides order; name defaults to id", () => {
  const r = resolveChatProviders(
    [
      { id: "a", base_url: "http://a/v1" },
      { id: "b", base_url: "http://b/v1", name: " Bee ", default: true },
    ],
    "http://t:1",
  );
  expect(r.errors).toEqual([]);
  expect(r.list.map((p) => [p.id, p.isDefault])).toEqual([
    ["a", false],
    ["b", true],
  ]);
  expect(r.list[0]!.name).toBe("a");
  expect(r.list[1]!.name).toBe(" Bee ");
});

test("api_key attaches to provider cfg", () => {
  const r = resolveChatProviders([{ id: "x", base_url: "u", api_key: "sk-1" }], "http://t");
  expect(r.list[0]!.cfg.apiKey).toBe("sk-1");
  expect(
    resolveChatProviders([{ id: "x", base_url: "u" }], "http://t").list[0]!.cfg.apiKey,
  ).toBeNull();
});

test("invalid specs are rejected with actionable errors", () => {
  const r = resolveChatProviders(
    [
      { id: "bad id!", base_url: "u" },
      { id: "ok", base_url: "u" },
      { id: "ok", base_url: "u2" },
      { id: "nourl", name: "x" },
    ],
    "http://t",
  );
  expect(r.errors.length).toBe(3);
  expect(r.errors.some((e) => e.includes("bad id!"))).toBe(true);
  expect(r.errors.some((e) => e.includes("duplicate id 'ok'"))).toBe(true);
  expect(r.errors.some((e) => e.includes("nourl") && e.includes("base_url"))).toBe(true);
  expect(r.list.length).toBe(1);
});

test("two defaults flagged is an error", () => {
  const r = resolveChatProviders(
    [
      { id: "a", base_url: "u", default: true },
      { id: "b", base_url: "u", default: true },
    ],
    "http://t",
  );
  expect(r.errors.some((e) => e.includes("only one provider"))).toBe(true);
});

test("publicProviders exposes no urls or keys", () => {
  const r = resolveChatProviders(
    [{ id: "s", name: "SecretCo", base_url: "https://x/v1", api_key: "sk-leak" }],
    "http://t",
  );
  const pub = publicProviders(r.list);
  expect(JSON.stringify(pub)).not.toContain("sk-leak");
  expect(JSON.stringify(pub)).not.toContain("x/v1");
  expect(pub.default).toBe("s");
  expect(pub.providers[0]).toEqual({ id: "s", name: "SecretCo", default: true, thinking: null });
});

test("pickProvider: omitted falls back to default, unknown returns undefined", () => {
  const r = resolveChatProviders(
    [
      { id: "a", base_url: "u" },
      { id: "b", base_url: "u", default: true },
    ],
    "http://t",
  );
  expect(pickProvider(r.list, null)!.id).toBe("b");
  expect(pickProvider(r.list, "")!.id).toBe("b");
  expect(pickProvider(r.list, "a")!.id).toBe("a");
  expect(pickProvider(r.list, "zz")).toBeUndefined();
});
