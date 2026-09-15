# Architecture

One Bun process, one web server, no database, no external services.

```
             ┌──────────────────────── cockpit.config.yaml ────────────────────────┐
             │ targets · chat.providers · custom adapters · server/gpu             │
             └──────────────────────────────────────────────────────────────────────┘
 engines        adapters                 poll loop (every poll_interval_s)
┌─────────┐  ┌───────────────────────┐   ┌────────────────────────────────────────┐
│ SGLang  │─▶│ detect / check /      │──▶│ Snapshot (canonical, all fields        │
│ vLLM    │  │ describe / sample     │   │ nullable) → Ring (450 pts ≈ 15 min)    │
│ custom  │  │ prom.ts parse+merge   │   │ deriveRates(prev,next): *_Tps,         │
│ (yaml)  │  └───────────────────────┘   │ requestsPerSec, cumulativeHitRate      │
└─────────┘                              └────────────────────────────────────────┘
                                                       │
        HTTP routes (src/server.ts)                   ▼
   /api/health · /api/targets · /api/snapshot · /api/history[&compact=1]
   /api/gpu · /api/chat/providers · /api/chat/models?provider= · /api/chat/stream?provider=
   /api/validate-mapping · /  (index.html) · /web/* (pre-compressed assets)
                                                       │
                                                       ▼
   web/main.tsx (React 19 + ECharts): App polls snapshot+history+gpu every 2 s;
   Chat proxies provider::model selection; session state lives in localStorage;
   UI is capability-driven — null field ⇒ element not rendered.
```

## Deliberate invariants

- **Canonical snapshot is the only interface** between engines and UI. UI
  never sees metric names; adapters never see the DOM.
- **Rates are derived from ring-adjacent samples** (`deriveRates`), never by
  the engine adapters — counter resets and first samples yield `null`.
- **Zero server-side conversation storage.** Chat history lives in the
  operator's browser; the server only pipes SSE (with keepalive pings, a
  socket-enforced 12 MB cap, and a 10-minute deadline).
- **Secrets stay server-side**: providers expose id/name/thinking-toggle to
  the browser only (`publicProviders` strips base_url + keys — test-enforced).
- **Static serving is cwd-independent**: assets resolve relative to cwd or
  the executable (`webRoot()`), so `dist/cockpit`, the Docker image, and dev
  all serve identical UI.
- **No runtime dependencies**: `scripts/build.ts` bundles everything;
  `bun build --compile` produces the single-file binary; JS asset filenames
  carry content hashes and are served `immutable`, everything else `no-store`
  with brotli/gzip sidecar negotiation.

## Module map

| Path | Responsibility |
|---|---|
| `src/core/model.ts` | canonical Snapshot types + emptySnapshot |
| `src/core/prom.ts` | Prometheus text → series/histograms (label-split merging) |
| `src/core/derive.ts` | quantiles, rates, `deriveRates` |
| `src/core/ring.ts` | 15-min ring buffer |
| `src/core/keepalive.ts` | SSE ping wrapper |
| `src/core/gpu.ts` | nvidia-smi probe/parse (optional panel) |
| `src/adapters/*` | sglang / vllm / custom (declarative) / registry |
| `src/chat/providers.ts` | provider resolution + public list (no secrets) |
| `src/chat/openai.ts` | models + streaming connectors |
| `src/server.ts` | config, poll loop, routes, static serving |
| `web/*` | UI (`chatPayload.ts` = pure chat logic incl. localStorage) |
| `test/*` | 60+ unit tests + route-level HTTP integration tests |
