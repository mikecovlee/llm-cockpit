# llm-cockpit

Multi-engine inference console: a live metrics cockpit plus an OpenAI-compatible
chat window, in one process.

**Adapter-driven**: SGLang, vLLM, and any custom engine via declarative mapping
(Prometheus metric names or JSON paths). The UI renders a canonical, engine-agnostic
model — adding a new engine means one small adapter file, not a UI rewrite.

> Early development (M1: API layer + adapters + tests). Full docs, screenshots and
> the single-binary release ship with M4.

## Requirements

- Docker (the whole toolchain runs in containers; the host stays clean)
- A running inference engine that exposes Prometheus metrics at `/metrics`
  (SGLang: `--enable-metrics`)

## Quick start

```bash
make run     # dev server in a container, http://127.0.0.1:7777 (host network)
make test    # unit tests in a container
make image   # build the runtime image
```

Zero-config: monitors `http://127.0.0.1:8080` with auto-detected engine.
Multiple targets, custom adapters, chat endpoint and server bind/port:
copy `cockpit.config.example.yaml` to `cockpit.config.yaml`.

## HTTP API (M1)

| Route | Description |
|---|---|
| `GET /api/health` | liveness + target count |
| `GET /api/targets` | targets with adapter, status, model |
| `GET /api/snapshot?target=id` | latest normalized snapshot (live counters, histograms, rates) |
| `GET /api/history?target=id&sec=600` | rolling ring buffer (≤30 min @ 2 s) |
| `POST /api/validate-mapping` | validate a custom adapter config + return a live parsed sample |

## Canonical model

Adapters normalize every engine into one schema (`src/core/model.ts`):
requests (running/queued/swapped/paused), throughput (generation/prefill TPS,
requests/s), token counters, KV cache usage + hit rates, host-tier (L2) usage,
latency histograms (TTFT/TPOT/E2E/queue wait → p50/p90/p99), fault counters
(retractions/preemptions), and free-form `extras`. Capability flags
(`mamba`, `hicache`, …) are advertised so the UI renders only what exists.

## Layout

```
src/core/      canonical model, prometheus parser, derivation (rates/quantiles)
src/adapters/  sglang, vllm, custom (declarative), registry + auto-detect
src/chat/      OpenAI-compatible connector (M3)
web/           React + ECharts frontend (M2)
test/          unit tests + engine fixtures
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
