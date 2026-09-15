/**
 * llm-cockpit server: config load, adapter resolution, poll loop, HTTP API.
 * Single process, zero runtime deps (yaml is bundled at build time).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
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
import { chatStream, listModels } from "./chat/openai.ts";
import {
  type ChatProviderSpec,
  pickProvider,
  publicProviders,
  resolveChatProviders,
} from "./chat/providers.ts";
import { deriveRates, histogramToQuantiles } from "./core/derive.ts";
import { withSseKeepalive } from "./core/keepalive.ts";
import type { HistogramBuckets, Snapshot } from "./core/model.ts";
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
  chat?: { providers?: ChatProviderSpec[] };
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
const firstTargetUrl =
  typeof config.targets?.[0]?.url === "string"
    ? (config.targets[0] as { url: string }).url
    : "http://127.0.0.1:8080";
const resolvedChat = resolveChatProviders(config.chat?.providers, firstTargetUrl);
if (resolvedChat.errors.length > 0) {
  console.error("[config] invalid chat.providers:");
  for (const e of resolvedChat.errors) console.error(`  ${e}`);
  process.exit(1);
}
const chatProviders = resolvedChat.list;
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
  if (typeof tc?.url !== "string") {
    console.error(`[config] target '${id}': url must be a string — skipped`);
    continue;
  }

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
  const prev = ring.latest();
  deriveRates(prev, snap, prev === null ? 0 : ts - prev.ts);
  ring.push(snap);
  t.status = snap.engine.healthy ? "online" : "offline";
  if (snap.engine.model !== null) t.model = snap.engine.model;
  if (snap.engine.version !== null) t.version = snap.engine.version;
}

async function refreshAll(): Promise<void> {
  const ts = Date.now();
  await Promise.all(targets.map((t, i) => refresh(t, adapters[i]!, rings[i]!, ts)));
}

let timer: ReturnType<typeof setTimeout> | null = null;
const schedulePoll = (): void => {
  timer = setTimeout(() => {
    void refreshAll().finally(schedulePoll);
  }, serverCfg.pollIntervalS * 1000);
};
await refreshAll();
schedulePoll();

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

/** JSON/HTML response with brotli/gzip negotiation (API payloads; static files
 * are pre-compressed at build time instead). */
function encodedResponse(req: Request, body: string, type: string): Response {
  const ae = req.headers.get("accept-encoding") ?? "";
  const headers: Record<string, string> = {
    "content-type": type,
    "cache-control": "no-store",
    vary: "Accept-Encoding",
  };
  if (ae.includes("br")) {
    headers["content-encoding"] = "br";
    return new Response(brotliCompressSync(Buffer.from(body)), { headers });
  }
  if (ae.includes("gzip")) {
    headers["content-encoding"] = "gzip";
    return new Response(gzipSync(Buffer.from(body), { level: 6 }), { headers });
  }
  return new Response(body, { headers });
}

function tripleOf(h: HistogramBuckets | null) {
  return h === null ? null : histogramToQuantiles(h);
}

/** Chart-relevant scalars only — strips histogram buckets and unused groups
 * (≈4× smaller before compression; 30×+ after). */
function toChartPoint(s: Snapshot) {
  return {
    ts: s.ts,
    requests: {
      running: s.requests.running,
      queued: s.requests.queued,
      paused: s.requests.paused,
      swapped: s.requests.swapped,
    },
    throughput: {
      generationTps: s.throughput.generationTps,
      prefillTps: s.throughput.prefillTps,
      prefillEffectiveTps: s.throughput.prefillEffectiveTps,
    },
    cache: {
      kvUsagePct: s.cache.kvUsagePct,
      hostUsedTokens: s.cache.hostUsedTokens,
      hostTotalTokens: s.cache.hostTotalTokens,
    },
    latency: { ttft: tripleOf(s.latency.ttft) },
  };
}

/** Read a request body enforcing a hard byte cap regardless of encoding or
 * absent content-length headers (chunked bodies included). */
async function readCappedText(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return null;
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const dec = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    if (r.value !== undefined) {
      total += r.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      out += dec.decode(r.value, { stream: true });
    }
  }
  out += dec.decode();
  return out;
}

async function validateMappingHandler(req: Request): Promise<Response> {
  const rawBody = await readCappedText(req, 1024 * 1024);
  if (rawBody === null) return jsonResponse({ ok: false, errors: ["payload exceeds 1MB"] }, 413);
  let body: { spec?: CustomAdapterSpec; target_url?: string } | null = null;
  try {
    body = JSON.parse(rawBody) as { spec?: CustomAdapterSpec; target_url?: string };
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
const indexBr = brotliCompressSync(Buffer.from(indexHtml));
const indexGz = gzipSync(Buffer.from(indexHtml), { level: 9 });

const MIME: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
};

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
      return encodedResponse(
        req,
        JSON.stringify({ target: targets[i]!.id, snapshot: snap }),
        "application/json; charset=utf-8",
      );
    }

    if (u.pathname === "/api/history") {
      const i = targetIndex(u.searchParams.get("target"));
      if (i < 0) return jsonResponse({ error: "unknown target" }, 404);
      const secRaw = Number(u.searchParams.get("sec") ?? "600");
      const sec = Number.isFinite(secRaw) ? Math.min(1800, Math.max(5, secRaw)) : 600;
      const points = rings[i]!.within(sec);
      const compact = u.searchParams.get("compact") === "1";
      return encodedResponse(
        req,
        JSON.stringify({
          target: targets[i]!.id,
          interval_s: serverCfg.pollIntervalS,
          points: compact ? points.map(toChartPoint) : points,
        }),
        "application/json; charset=utf-8",
      );
    }

    if (u.pathname === "/api/validate-mapping") {
      if (req.method !== "POST") {
        return jsonResponse({ ok: false, errors: ["method not allowed"] }, 405);
      }
      return validateMappingHandler(req);
    }

    if (u.pathname === "/api/chat/providers") {
      return jsonResponse(publicProviders(chatProviders));
    }

    if (u.pathname === "/api/chat/models") {
      const provider = pickProvider(chatProviders, u.searchParams.get("provider"));
      if (provider === undefined)
        return jsonResponse(
          { ok: false, error: `unknown provider '${u.searchParams.get("provider")}'` },
          404,
        );
      try {
        const r = await listModels(provider.cfg);
        const body = await r.text();
        if (!r.ok) {
          return jsonResponse(
            {
              ok: false,
              error: `chat endpoint ${provider.id} (${provider.cfg.baseUrl}): HTTP ${r.status}`,
            },
            r.status >= 500 ? 502 : r.status === 404 ? 404 : 502,
          );
        }
        return new Response(body, { headers: { "content-type": "application/json" } });
      } catch {
        return jsonResponse(
          {
            ok: false,
            error: `chat endpoint unreachable (${provider.id}: ${provider.cfg.baseUrl})`,
          },
          502,
        );
      }
    }

    if (u.pathname === "/api/chat/stream") {
      if (req.method !== "POST")
        return jsonResponse({ ok: false, error: "method not allowed" }, 405);
      const raw = await readCappedText(req, 12 * 1024 * 1024);
      if (raw === null) return jsonResponse({ ok: false, error: "payload exceeds 12MB" }, 413);
      let payload: unknown;
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        return jsonResponse({ ok: false, error: "body must be valid JSON" }, 400);
      }
      if (!Array.isArray((payload as { messages?: unknown })?.messages)) {
        return jsonResponse({ ok: false, error: "messages[] is required" }, 400);
      }
      const provider = pickProvider(chatProviders, u.searchParams.get("provider"));
      if (provider === undefined)
        return jsonResponse(
          { ok: false, error: `unknown provider '${u.searchParams.get("provider")}'` },
          404,
        );
      try {
        const r = await chatStream(provider.cfg, payload as Record<string, unknown>, req.signal);
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
          {
            ok: false,
            error: `chat endpoint unreachable (${provider.id}: ${provider.cfg.baseUrl})`,
          },
          502,
        );
      }
    }

    if (u.pathname === "/" || u.pathname === "/index.html") {
      const ae = req.headers.get("accept-encoding") ?? "";
      const h: Record<string, string> = {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        vary: "Accept-Encoding",
      };
      if (ae.includes("br"))
        return new Response(indexBr, { headers: { ...h, "content-encoding": "br" } });
      if (ae.includes("gzip"))
        return new Response(indexGz, { headers: { ...h, "content-encoding": "gzip" } });
      return new Response(indexHtml, { headers: h });
    }

    if (u.pathname.startsWith("/web/")) {
      const rel = u.pathname.slice("/web/".length);
      if (rel.includes("..") || rel.includes("\0"))
        return new Response("forbidden", { status: 403 });
      if (webRootDir === null) return new Response("not found", { status: 404 });
      const file = join(webRootDir, rel);
      if (existsSync(file)) {
        const ext = rel.slice(rel.lastIndexOf(".") + 1);
        const type = MIME[ext] ?? "application/octet-stream";
        const cached = /^main-[0-9a-f]+\.js$/.test(rel)
          ? "public, max-age=31536000, immutable"
          : "no-store";
        const ae = req.headers.get("accept-encoding") ?? "";
        const headers: Record<string, string> = {
          "content-type": type,
          "cache-control": cached,
          vary: "Accept-Encoding",
        };
        if (ae.includes("br") && existsSync(`${file}.br`)) {
          return new Response(Bun.file(`${file}.br`), {
            headers: { ...headers, "content-encoding": "br" },
          });
        }
        if (ae.includes("gzip") && existsSync(`${file}.gz`)) {
          return new Response(Bun.file(`${file}.gz`), {
            headers: { ...headers, "content-encoding": "gzip" },
          });
        }
        return new Response(Bun.file(file), { headers });
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
console.log(
  `[llm-cockpit] chat providers: ${chatProviders
    .map((p) => `${p.id}${p.isDefault ? " (default)" : ""}`)
    .join(", ")}`,
);

process.on("SIGTERM", () => {
  if (timer !== null) clearTimeout(timer);
  server.stop();
  process.exit(0);
});
