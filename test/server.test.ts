import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENGINE_PORT = 17795;
const APP_PORT = 17788;
const BASE = `http://127.0.0.1:${APP_PORT}`;

const metrics = readFileSync("test/fixtures/sglang/metrics.txt", "utf8");
const serverInfo = readFileSync("test/fixtures/sglang/server_info.json", "utf8");

let engine: ReturnType<typeof Bun.serve> | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

beforeAll(async () => {
  engine = Bun.serve({
    hostname: "127.0.0.1",
    port: ENGINE_PORT,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/server_info") return new Response(serverInfo);
      if (u.pathname === "/health") return new Response("ok");
      if (u.pathname === "/metrics") return new Response(metrics);
      if (u.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: "fixture-model", object: "model" }] });
      }
      if (u.pathname === "/v1/chat/completions" && req.method === "POST") {
        const body =
          sseChunk({ choices: [{ delta: { content: "fixture reply" } }] }) +
          sseChunk({
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }) +
          "data: [DONE]\n\n";
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const dir = mkdtempSync(join(tmpdir(), "cockpit-it-"));
  const cfg = join(dir, "cockpit.config.yaml");
  writeFileSync(
    cfg,
    [
      "server:",
      "  host: 127.0.0.1",
      `  port: ${APP_PORT}`,
      "  poll_interval_s: 1",
      "targets:",
      `  - url: http://127.0.0.1:${ENGINE_PORT}`,
      "chat:",
      "  providers:",
      "    - id: fixture",
      "      name: Fixture",
      `      base_url: http://127.0.0.1:${ENGINE_PORT}/v1`,
      "    - id: broken",
      "      name: Broken",
      "      base_url: http://127.0.0.1:9/v1",
    ].join("\n"),
  );

  child = Bun.spawn([process.execPath, "run", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, COCKPIT_CONFIG: cfg },
    stdout: "ignore",
    stderr: "ignore",
  });

  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }
  throw new Error("cockpit server did not start");
});

afterAll(() => {
  child?.kill(9);
  engine?.stop(true);
});

test("health + targets with sglang auto-detection", async () => {
  const t = (await (await fetch(`${BASE}/api/targets`)).json()) as {
    targets: { adapter: string; status: string; model: string | null }[];
  };
  expect(t.targets.length).toBe(1);
  expect(t.targets[0]!.adapter).toBe("sglang");
  expect(t.targets[0]!.status).toBe("online");
  expect(t.targets[0]!.model).toContain("Qwen");
});

test("snapshot is normalized from fixture metrics", async () => {
  const s = (await (await fetch(`${BASE}/api/snapshot`)).json()) as {
    snapshot: {
      tokens: { promptTotal: number | null };
      cache: {
        kvUsagePct: number | null;
        kvAvailableTokens: number | null;
        deviceHitTotal: number | null;
        cumulativeHitRate: number | null;
      };
      engine: { healthy: boolean };
    };
  };
  expect(s.snapshot.engine.healthy).toBe(true);
  expect(s.snapshot.tokens.promptTotal).not.toBeNull();
  expect(s.snapshot.cache.kvAvailableTokens).toBe(484);
  expect(s.snapshot.cache.deviceHitTotal).toBe(1.279936e7);
  expect(s.snapshot.cache.cumulativeHitRate).not.toBeNull();
});

test("history full + compact", async () => {
  const full = (await (await fetch(`${BASE}/api/history?sec=60`)).json()) as {
    points: Record<string, unknown>[];
  };
  expect(full.points.length).toBeGreaterThan(0);
  const compact = (await (await fetch(`${BASE}/api/history?sec=60&compact=1`)).json()) as {
    points: { ts: number; requests: unknown; cache: unknown; latency: { ttft: unknown } }[];
  };
  expect(compact.points.length).toBeGreaterThan(0);
  const p = compact.points[0]!;
  expect(Object.keys(p).sort()).toEqual(["cache", "latency", "requests", "throughput", "ts"]);
});

test("chat providers list exposes no base_url or keys", async () => {
  const text = await (await fetch(`${BASE}/api/chat/providers`)).text();
  expect(text).toContain("fixture");
  expect(text).not.toContain(String(ENGINE_PORT));
  expect(text).not.toContain("base_url");
});

test("models routed per provider; unknown provider 404; broken provider 502", async () => {
  const ok = (await (await fetch(`${BASE}/api/chat/models?provider=fixture`)).json()) as {
    data: { id: string }[];
  };
  expect(ok.data[0]!.id).toBe("fixture-model");
  expect((await fetch(`${BASE}/api/chat/models?provider=nope`)).status).toBe(404);
  expect((await fetch(`${BASE}/api/chat/models?provider=broken`)).status).toBe(502);
});

test("stream routes to the chosen provider and passes SSE through", async () => {
  const r = await fetch(`${BASE}/api/chat/stream?provider=fixture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture-model", messages: [{ role: "user", content: "hi" }] }),
  });
  expect(r.ok).toBe(true);
  expect(r.headers.get("content-type")).toContain("text/event-stream");
  const text = await r.text();
  expect(text).toContain("fixture reply");
  expect(text).toContain("[DONE]");
});

test("oversized chat body rejected with 413", async () => {
  const big = "A".repeat(13 * 1024 * 1024);
  const r = await fetch(`${BASE}/api/chat/stream?provider=fixture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: big }] }),
  });
  expect(r.status).toBe(413);
});

test("gpu shape without nvidia-smi access", async () => {
  const g = (await (await fetch(`${BASE}/api/gpu`)).json()) as {
    available: boolean;
    gpus: unknown[];
  };
  expect(typeof g.available).toBe("boolean");
  expect(Array.isArray(g.gpus)).toBe(true);
});

test("static page: html + no-store; unknown api 404", async () => {
  const page = await fetch(`${BASE}/`);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(page.headers.get("cache-control")).toContain("no-store");
  expect((await fetch(`${BASE}/api/nope`)).status).toBe(404);
});

test("server still boots when configured targets are unusable", async () => {
  const port = 17789;
  const dir = mkdtempSync(join(tmpdir(), "cockpit-empty-"));
  const cfg = join(dir, "cockpit.config.yaml");
  writeFileSync(cfg, ["server:", "  host: 127.0.0.1", `  port: ${port}`].join("\n"));

  const empty = Bun.spawn([process.execPath, "run", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, COCKPIT_CONFIG: cfg },
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) {
          expect(await r.json()).toMatchObject({ ok: true, targets: 0 });
          const targetsResponse = await fetch(`http://127.0.0.1:${port}/api/targets`);
          expect(targetsResponse.ok).toBe(true);
          const targets = (await targetsResponse.json()) as {
            targets: unknown[];
          };
          expect(targets.targets).toEqual([]);
          return;
        }
      } catch {
        // not up yet
      }
      await Bun.sleep(250);
    }
    throw new Error("cockpit server did not start without usable targets");
  } finally {
    empty.kill(9);
  }
});
