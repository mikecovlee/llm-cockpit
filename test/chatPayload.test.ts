import { expect, test } from "bun:test";
import { resolveChatProviders } from "../src/chat/providers.ts";
import {
  buildPayload,
  defaultMetrics,
  defaultParams,
  formatUsage,
  loadSession,
  parseUsage,
  SESSION_KEY,
  type SessionState,
  saveSession,
} from "../web/chatPayload.ts";

test("buildPayload includes only non-null params, prepends system, merges thinking fragment", () => {
  const p = buildPayload({
    model: "m",
    history: [{ role: "user", content: "hi" }],
    params: { ...defaultParams(), temperature: 0.7, maxTokens: 128, system: "  be nice  " },
    thinking: { on: { chat_template_kwargs: { enable_thinking: true } }, off: null },
    includeUsage: false,
  });
  const msgs = p["messages"] as { role: string; content: unknown }[];
  expect(msgs.length).toBe(2);
  expect(msgs[0]).toEqual({ role: "system", content: "be nice" });
  expect(p["temperature"]).toBe(0.7);
  expect(p["max_tokens"]).toBe(128);
  expect(p["top_p"]).toBeUndefined();
  expect((p["chat_template_kwargs"] as { enable_thinking: boolean }).enable_thinking).toBe(true);
  expect(p["stream_options"]).toBeUndefined();
});

test("thinking off uses off-fragment; stream_options on flag", () => {
  const p = buildPayload({
    model: "m",
    history: [],
    params: { ...defaultParams(), thinkingOn: false },
    thinking: {
      on: { chat_template_kwargs: { enable_thinking: true } },
      off: { chat_template_kwargs: { enable_thinking: false } },
    },
    includeUsage: true,
  });
  expect((p["chat_template_kwargs"] as { enable_thinking: boolean }).enable_thinking).toBe(false);
  expect(p["stream_options"]).toEqual({ include_usage: true });
});

test("parseUsage extracts totals + reasoning tokens; ignores non-usage chunks", () => {
  expect(parseUsage({ choices: [{ delta: { content: "x" } }] })).toBeNull();
  const u = parseUsage({
    choices: [],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 345,
      total_tokens: 357,
      completion_tokens_details: { reasoning_tokens: 300 },
    },
  });
  expect(u).toEqual({ prompt: 12, completion: 345, total: 357, reasoning: 300 });
});

test("formatUsage respects toggles", () => {
  const u = {
    prompt: 1200,
    completion: 345,
    reasoning: 300,
    total: 1545,
    tps: 45.6,
    ttftMs: 1200,
  };
  const all = formatUsage(u, defaultMetrics());
  expect(all).toContain("↑1.2k");
  expect(all).toContain("↓345");
  expect(all).toContain("R 300");
  expect(all).toContain("45.6 tok/s");
  expect(all).toContain("TTFT 1.2s");
  expect(formatUsage(u, { tokens: false, tps: false, ttft: false, reasoning: false })).toBe("");
});

class MemStorage {
  map = new Map<string, string>();
  failNext = false;
  limit = Infinity;
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("QuotaExceededError");
    }
    if (v.length > this.limit) throw new Error("QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

function asStorage(m: MemStorage): Storage {
  return m as unknown as Storage;
}

const session: SessionState = {
  v: 1,
  sel: "deepseek::deepseek-flash",
  params: { ...defaultParams(), temperature: 0.5 },
  metrics: defaultMetrics(),
  msgs: [
    { id: "a", role: "user", content: "hi", images: ["data:image/png;base64,AAAA"] },
    { id: "b", role: "assistant", content: "yo", thinking: "hmm" },
  ],
};

test("session roundtrip", () => {
  const st = new MemStorage();
  expect(saveSession(asStorage(st), session)).toBe(true);
  const back = loadSession(asStorage(st));
  expect(back).not.toBeNull();
  expect(back!.sel).toBe("deepseek::deepseek-flash");
  expect(back!.params.temperature).toBe(0.5);
  expect(back!.msgs.length).toBe(2);
  expect(back!.msgs[0]!.images).toEqual(["data:image/png;base64,AAAA"]);
});

test("quota overflow retries once without images", () => {
  const st = new MemStorage();
  st.failNext = true; // first (full) setItem throws; retry strips images
  expect(saveSession(asStorage(st), session)).toBe(true);
  const back = loadSession(asStorage(st));
  expect(back!.msgs.length).toBe(2);
  expect(back!.msgs[0]!.images).toBeUndefined();
});

test("corrupt + absent session -> null", () => {
  const st = new MemStorage();
  expect(loadSession(asStorage(st))).toBeNull();
  st.map.set(SESSION_KEY, "{not json");
  expect(loadSession(asStorage(st))).toBeNull();
  st.map.set(SESSION_KEY, JSON.stringify({ msgs: "nope" }));
  expect(loadSession(asStorage(st))).toBeNull();
});

test("thinking_toggle survives provider resolution + public mapping", () => {
  const r = resolveChatProviders(
    [
      {
        id: "local",
        base_url: "u",
        thinking_toggle: { off: { chat_template_kwargs: { enable_thinking: false } } },
      },
      { id: "plain", base_url: "u" },
    ],
    "http://t",
  );
  expect(r.errors).toEqual([]);
  expect(r.list[0]!.thinking).toEqual({
    on: null,
    off: { chat_template_kwargs: { enable_thinking: false } },
  });
  expect(r.list[1]!.thinking).toBeNull();
});
