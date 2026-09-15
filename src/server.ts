/**
 * llm-cockpit server: config load, adapter resolution, poll loop, HTTP API.
 * Single process, zero runtime deps (yaml is bundled at build time).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "bun";
import { parse as parseYaml } from "yaml";
import {
  type CustomAdapterSpec,
  createCustomAdapter,
  normalizeCustom,
  resolveJsonPath,
  validateCustomSpec,
} from "./adapters/custom.ts";
import { fetchText } from "./adapters/http.ts";
import { autoDetect, builtins } from "./adapters/index.ts";
import type { EngineAdapter } from "./adapters/types.ts";
import { type ChatConfig, chatStream, listModels } from "./chat/openai.ts";
import { findHistogram, findSeries, parsePrometheus } from "./core/prom.ts";
import { Ring, ringCapacity, type Target } from "./core/registry.ts";

interface TargetConfig {
  id?: string;
  url: string;
  /** Force a builtin adapter id; omit for auto-detection. */
  adapter?: string;
  /** Reference a custom adapter from `custom:` instead of `adapter:`. */
  custom?: string;
}

interface AppConfig {
  targets?: TargetConfig[];
  chat?: { base_url?: string; api_key?: string };
  custom?: CustomAdapterSpec[];
  server?: { host?: string; port?: number; poll_interval_s?: number };
}

function loadConfig(): AppConfig {
  const envPath = process.env["COCKPIT_CONFIG"];
  const path =
    envPath !== undefined && envPath !== ""
      ? envPath
      : existsSync("cockpit.config.yaml")
        ? "cockpit.config.yaml"
        : null;
  if (path === null) return {};
  try {
    const j = parseYaml(readFileSync(path, "utf8")) as unknown;
    if (j === null || j === undefined || typeof j !== "object") return {};
    return j as AppConfig;
  } catch (e) {
    console.error(`[config] failed to parse ${path}: ${String(e)}`);
    process.exit(1);
  }
}

const config = loadConfig();
const chatBase: ChatConfig = {
  baseUrl: config.chat?.base_url ?? "http://127.0.0.1:8080/v1",
  apiKey: config.chat?.api_key ?? null,
};
const serverCfg = {
  host: config.server?.host ?? "0.0.0.0",
  port: config.server?.port ?? 7777,
  pollIntervalS: Math.max(1, config.server?.poll_interval_s ?? 2),
};

const customSpecs = new Map<string, CustomAdapterSpec>();
for (const spec of config.custom ?? []) {
  const errs = validateCustomSpec(spec);
  if (errs.length > 0) {
    console.error(`[config] invalid custom adapter '${spec.id}':`);
    for (const e of errs) console.error(`  ${e}`);
    process.exit(1);
  }
  customSpecs.set(spec.id, spec);
}

const targetConfigs: TargetConfig[] =
  config.targets !== undefined && config.targets.length > 0
    ? config.targets
    : [{ url: "http://127.0.0.1:8080" }];

const targets: Target[] = [];
const adapters: EngineAdapter[] = [];
const rings: Ring[] = [];

for (let i = 0; i < targetConfigs.length; i++) {
  const tc = targetConfigs[i]!;
  const id = tc.id ?? `t${i + 1}`;

  let adapter: EngineAdapter;
  let adapterId: string;
  if (tc.custom !== undefined) {
    const spec = customSpecs.get(tc.custom);
    if (spec === undefined) {
      console.error(`[config] target '${id}': unknown custom adapter '${tc.custom}'`);
      process.exit(1);
    }
    adapterId = spec.id;
    adapter = createCustomAdapter(spec);
  } else if (tc.adapter !== undefined) {
    const b = builtins[tc.adapter];
    const c = customSpecs.get(tc.adapter);
    if (b === undefined && c === undefined) {
      console.error(`[config] target '${id}': unknown adapter '${tc.adapter}'`);
      process.exit(1);
    }
    adapterId = b !== undefined ? b.id : c!.id;
    adapter = b !== undefined ? b : createCustomAdapter(c!);
  } else {
    try {
      adapterId = await autoDetect(tc.url);
    } catch (e) {
      console.error(`[config] target '${id}' (${tc.url}): ${String(e)} — skipped`);
      continue;
    }
    const b = builtins[adapterId];
    if (b === undefined) continue;
    adapter = b;
  }

  targets.push({
    id,
    url: tc.url,
    adapter: adapterId,
    status: "pending",
    model: null,
    version: null,
  });
  adapters.push(adapter);
  rings.push(new Ring(ringCapacity(serverCfg.pollIntervalS)));
}

if (targets.length === 0) {
  console.error("[config] no usable targets — nothing to monitor");
  process.exit(1);
}

const startedAt = Date.now();

async function refresh(t: Target, adapter: EngineAdapter, ring: Ring, ts: number): Promise<void> {
  const snap = await adapter.sample(t.url, ts);
  ring.push(snap);
  t.status = snap.engine.healthy ? "online" : "offline";
  if (snap.engine.model !== null) t.model = snap.engine.model;
  if (snap.engine.version !== null) t.version = snap.engine.version;
}

async function refreshAll(): Promise<void> {
  const ts = Date.now();
  await Promise.all(targets.map((t, i) => refresh(t, adapters[i]!, rings[i]!, ts)));
}

await refreshAll();
const timer = setInterval(() => {
  void refreshAll();
}, serverCfg.pollIntervalS * 1000);

function targetIndex(name: string | null): number {
  if (name === null || name === undefined) return 0;
  return targets.findIndex((t) => t.id === name);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function validateMappingHandler(req: Request): Promise<Response> {
  let body: { spec?: CustomAdapterSpec; target_url?: string } | null = null;
  try {
    body = (await req.json()) as { spec?: CustomAdapterSpec; target_url?: string };
  } catch {
    return jsonResponse({ ok: false, errors: ["body must be valid JSON"] }, 400);
  }
  const spec = body?.spec;
  if (spec === undefined || spec === null) {
    return jsonResponse({ ok: false, errors: ["spec is required"] }, 400);
  }
  const errors = validateCustomSpec(spec);
  if (errors.length > 0) return jsonResponse({ ok: false, errors }, 422);

  const url = body?.target_url ?? spec.url ?? "";
  if (url === "") {
    return jsonResponse({
      ok: true,
      errors: [],
      live: false,
      note: "spec valid; no URL provided for a live probe",
    });
  }

  const r = await fetchText(url);
  if (!r.ok) {
    return jsonResponse({
      ok: true,
      errors: [],
      live: false,
      note: `live probe failed: HTTP ${r.status}`,
    });
  }

  if (spec.source === "prometheus") {
    const p = parsePrometheus(r.text);
    const sample = normalizeCustom(p, null, spec, Date.now());
    const missing = Object.entries(spec.mapping)
      .filter(([, metric]) => findSeries(p, metric) === null && findHistogram(p, metric) === null)
      .map(([field, metric]) => `mapping['${field}']: metric '${metric}' not found in response`);
    return jsonResponse({ ok: true, errors: [], live: true, missing, sample });
  }

  try {
    const json: unknown = JSON.parse(r.text);
    const sample = normalizeCustom(null, json, spec, Date.now());
    const missing = Object.entries(spec.mapping)
      .filter(([, path]) => resolveJsonPath(json, path) === null)
      .map(([field, path]) => `mapping['${field}']: JSON path '${path}' resolved to null`);
    return jsonResponse({ ok: true, errors: [], live: true, missing, sample });
  } catch {
    return jsonResponse({ ok: true, errors: [], live: false, note: "response is not valid JSON" });
  }
}

/**
 * Resolve the web-assets directory (`dist/web`) regardless of how the server
 * is launched: `bun run src/server.ts` from the repo root (cwd = root), the
 * bundled `dist/server.js`, or the compiled single-file binary (cwd may be
 * anywhere, so anchor on the executable's own location).
 */
function webRoot(): string | null {
  const candidates = ["dist/web"];
  // process.execPath is the real filesystem path of the executable in the
  // compiled binary (Bun.main is a virtual /$bunfs path there), so anchor
  // asset resolution on it; harmless no-op in dev (points at the bun binary).
  const exec = process.execPath;
  if (exec !== "") {
    const mdir = dirname(exec);
    candidates.push(join(mdir, "web"));
  }
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return null;
}

const webRootDir = webRoot();
const indexHtml =
  webRootDir !== null
    ? readFileSync(join(webRootDir, "index.html"), "utf8")
    : existsSync("web/index.html")
      ? readFileSync("web/index.html", "utf8")
      : "<h1>llm-cockpit</h1>";

const MIME: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
};

/**
 * Interleave SSE comment pings into a proxied stream so the connection shows
 * activity even while the engine is stalled in queue or long prefill.
 */
function withSseKeepalive(src: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const reader = src.getReader();
  let active = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  const halt = (): void => {
    active = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  return new ReadableStream<Uint8Array>({
    start(c) {
      timer = setInterval(() => {
        if (!active) return;
        try {
          c.enqueue(enc.encode(": ping\n\n"));
        } catch {
          halt();
        }
      }, 15000);
      const pump = (): void => {
        reader
          .read()
          .then(({ done, value }) => {
            if (!active) return;
            if (done) {
              halt();
              c.close();
              return;
            }
            if (value !== undefined) {
              try {
                c.enqueue(value);
              } catch {
                halt();
              }
            }
            pump();
          })
          .catch(() => {
            if (!active) return;
            halt();
            c.error(new Error("upstream stream failed"));
          });
      };
      pump();
    },
    cancel(reason) {
      halt();
      reader.cancel(reason).catch(() => {});
    },
  });
}

const server = serve({
  hostname: serverCfg.host,
  port: serverCfg.port,
  idleTimeout: 255,
  async fetch(req: Request) {
    const u = new URL(req.url);

    if (u.pathname === "/api/health") {
      return jsonResponse({
        ok: true,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        targets: targets.length,
      });
    }

    if (u.pathname === "/api/targets") {
      return jsonResponse({ targets });
    }

    if (u.pathname === "/api/snapshot") {
      const i = targetIndex(u.searchParams.get("target"));
      if (i < 0)
        return jsonResponse({ error: `unknown target '${u.searchParams.get("target")}'` }, 404);
      const snap = rings[i]!.latest();
      if (snap === null) return jsonResponse({ error: "no data collected yet" }, 503);
      return jsonResponse({ target: targets[i]!.id, snapshot: snap });
    }

    if (u.pathname === "/api/history") {
      const i = targetIndex(u.searchParams.get("target"));
      if (i < 0) return jsonResponse({ error: "unknown target" }, 404);
      const secRaw = Number(u.searchParams.get("sec") ?? "600");
      const sec = Number.isFinite(secRaw) ? Math.min(1800, Math.max(5, secRaw)) : 600;
      return jsonResponse({
        target: targets[i]!.id,
        interval_s: serverCfg.pollIntervalS,
        points: rings[i]!.within(sec),
      });
    }

    if (u.pathname === "/api/validate-mapping") {
      if (req.method !== "POST") {
        return jsonResponse({ ok: false, errors: ["method not allowed"] }, 405);
      }
      return validateMappingHandler(req);
    }

    if (u.pathname === "/api/chat/models") {
      try {
        const r = await listModels(chatBase);
        const body = await r.text();
        if (!r.ok) {
          return jsonResponse(
            {
              ok: false,
              error: `chat endpoint ${chatBase.baseUrl}: HTTP ${r.status}`,
            },
            r.status >= 500 ? 502 : r.status === 404 ? 404 : 502,
          );
        }
        return new Response(body, { headers: { "content-type": "application/json" } });
      } catch {
        return jsonResponse(
          { ok: false, error: `chat endpoint unreachable (${chatBase.baseUrl})` },
          502,
        );
      }
    }

    if (u.pathname === "/api/chat/stream") {
      if (req.method !== "POST")
        return jsonResponse({ ok: false, error: "method not allowed" }, 405);
      const len = Number(req.headers.get("content-length") ?? "0");
      if (len > 12 * 1024 * 1024)
        return jsonResponse({ ok: false, error: "payload exceeds 12MB" }, 413);
      let payload: unknown;
      try {
        payload = await req.json();
      } catch {
        return jsonResponse({ ok: false, error: "body must be valid JSON" }, 400);
      }
      if (!Array.isArray((payload as { messages?: unknown })?.messages)) {
        return jsonResponse({ ok: false, error: "messages[] is required" }, 400);
      }
      try {
        const r = await chatStream(chatBase, payload as Record<string, unknown>, req.signal);
        if (!r.ok) {
          const detail = await r.text();
          return jsonResponse({ ok: false, status: r.status, error: detail.slice(0, 2000) }, 502);
        }
        if (r.body === null) {
          return jsonResponse({ ok: false, error: "upstream returned no body" }, 502);
        }
        return new Response(withSseKeepalive(r.body), {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
          },
        });
      } catch {
        return jsonResponse(
          { ok: false, error: `chat endpoint unreachable (${chatBase.baseUrl})` },
          502,
        );
      }
    }

    if (u.pathname === "/" || u.pathname === "/index.html") {
      return new Response(indexHtml, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (u.pathname.startsWith("/web/")) {
      const rel = u.pathname.slice("/web/".length);
      if (rel.includes("..") || rel.includes("\0"))
        return new Response("forbidden", { status: 403 });
      if (webRootDir === null) return new Response("not found", { status: 404 });
      const file = join(webRootDir, rel);
      if (existsSync(file)) {
        const ext = rel.slice(rel.lastIndexOf(".") + 1);
        return new Response(Bun.file(file), {
          headers: {
            "content-type": MIME[ext] ?? "application/octet-stream",
            "cache-control": "no-store",
          },
        });
      }
      return new Response("not found", { status: 404 });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(
  `[llm-cockpit] listening on http://${serverCfg.host}:${serverCfg.port} — ${targets.length} target(s), poll every ${serverCfg.pollIntervalS}s`,
);
for (const t of targets) {
  console.log(`  - ${t.id}: ${t.url} (adapter=${t.adapter}, status=${t.status})`);
}

process.on("SIGTERM", () => {
  clearInterval(timer);
  server.stop();
  process.exit(0);
});
