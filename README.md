# llm-cockpit

Multi-engine inference console: a live metrics cockpit plus an OpenAI-compatible
chat window, in one process.

**Adapter-driven**: SGLang, vLLM, and any custom engine via declarative mapping
(Prometheus metric names or JSON paths). The UI renders a canonical, engine-agnostic
model — adding a new engine means one small adapter file, not a UI rewrite.

| monitor | chat |
|---|---|
| ![monitor](screenshots/m3-monitor.png) | ![chat](screenshots/m3-chat-reply.png) |

## Quick start

```bash
make run     # dev server in a container → http://<server-ip>:7777 (binds 0.0.0.0)
make test    # unit tests (32) in a container
make image   # build the runtime image
```

Requirements: Docker. A running inference engine that exposes Prometheus metrics
at `/metrics` (SGLang: start with `--enable-metrics`).

Zero-config: monitors `http://127.0.0.1:8080` with the engine auto-detected
(SGLang `/get_server_info`, vLLM `/version`). Multiple targets, custom adapters,
the chat endpoint and the bind address come from `cockpit.config.yaml`
(copy `cockpit.config.example.yaml`).

## The monitor

Capability-driven: every card and chart renders only what the engine actually
exposes (null = engine doesn't report it).

- **requests** — running / queued / paused / swapped, live sparkline
- **throughput** — generation (and prefill) tok/s
- **KV cache** — usage %, used/total tokens, cache hit rate, host-tier (L2/hicache)
  usage when the engine runs a host KV tier
- **latency** — TTFT / E2E / TPOT / queue-wait p50/p90/p99 derived from histograms
- **tokens / faults / extras / engine** — cumulative counters, retractions,
  engine-specific values (e.g. mamba occupancy, hicache load-back tokens)

Polling is every 2 s against the server's in-memory ring (15 min window).

## The chat

The chat window talks to any OpenAI-compatible API (default: the same engine at
`/v1`). Streaming responses render markdown with syntax highlighting; reasoning
models get a collapsible "thinking" block. `⏎` sends, `⇧⏎` inserts a newline,
stop aborts in-flight generation.

**Vision**: the `+` button attaches up to 4 images to a message. Large images are
auto-downscaled in the browser (≤ 1280px per side, JPEG q0.85) before upload — a
4000×3000 phone photo would otherwise expand to 100k+ vision tokens and stall the
engine's prefill for minutes. Images are sent as inline base64 `image_url` content
parts (proxy hard cap: 12 MB), so the same endpoint serves text and multimodal
traffic — the chat model must be vision-capable (e.g. a Qwen-VL serving).

## Custom engines (no code)

Declare a mapping in `cockpit.config.yaml`; values are Prometheus metric names
(`source: prometheus`) or JSON paths (`source: json`, e.g. `$.gpu[0].util`):

```yaml
custom:
  - id: my-engine
    source: prometheus
    url: http://127.0.0.1:8000/metrics
    health: http://127.0.0.1:8000/health
    mapping:
      requests.running: myengine_running
      requests.queued: myengine_waiting
      cache.kvUsagePct: myengine_kv_usage
      counts.requestsCompletedTotal: myengine_completed
      latency.ttft: myengine_ttft      # histogram base name
      extras.custom_metric: myengine_extra
    static:
      engine.model: my-model
targets:
  - id: mine
    url: http://127.0.0.1:8000
    custom: my-engine
```

Validate a mapping live (syntax check + fetch the endpoint + report which mapped
metrics are missing): `POST /api/validate-mapping`.

## HTTP API

| Route | Description |
|---|---|
| `GET /api/health` | liveness + target count |
| `GET /api/targets` | targets with adapter, status, model, version |
| `GET /api/snapshot?target=id` | latest normalized snapshot |
| `GET /api/history?target=id&sec=600` | rolling ring (≤ 15 min @ 2 s) |
| `POST /api/validate-mapping` | validate a custom adapter + live probe |
| `GET /api/chat/models` | model list from the configured chat endpoint |
| `POST /api/chat/stream` | SSE proxy → OpenAI `chat/completions` (stream) |

All numeric fields in the canonical model are nullable — the shape is stable
across engines; capabilities (`mamba`, `hicache`, `prefixCache`) tell the UI
what exists.

## Layout

```
src/core/      canonical model, prometheus parser, quantile/rate derivation, ring buffer
src/adapters/  sglang, vllm, custom (declarative), registry + auto-detect
src/chat/      OpenAI-compatible connector
web/           React 19 + ECharts frontend (bundled by scripts/build.ts)
test/          unit tests + engine fixtures
```

## Development

The whole toolchain runs in containers; the host stays clean (node_modules lives
in the docker volume `cockpit_mod`). `make typecheck` / `make lint` / `make test`
wrap the container equivalents. `bun run scripts/build.ts` bundles the server
(target bun, zero runtime deps) and the web app (browser). `make binary`
produces a single self-contained executable via `bun build --compile`.

## 中文说明

llm-cockpit 是一个多引擎推理控制台:一个进程里同时提供**实时指标监控**和
**OpenAI 兼容对话**两个界面。

- **适配器驱动**:内置 SGLang / vLLM 适配器,任意自研引擎通过声明式 YAML
  映射(Prometheus 指标名或 JSON 路径)接入,无需写代码。
- **规范模型**:所有引擎的指标被归一化为同一套结构(请求数、吞吐、KV 缓存、
  延迟直方图 p50/p90/p99、故障计数、extras),UI 只渲染引擎真实上报的字段
  (能力驱动,缺失即隐藏)。
- **对话窗口**:代理到任意 OpenAI-compatible API,支持 SSE 流式、reasoning
  模型 thinking 折叠、markdown + 代码高亮、随时停止;`+` 按钮可附加图片
  (每条最多 4 张,浏览器端自动压到 ≤1280px JPEG 再上传——原图直发会膨胀成
  十几万 token 把引擎卡死;需视觉模型支持)。
- **容器化工具链**:`make run / test / typecheck / lint / image / binary`
  全部在容器内执行,不污染宿主机。

快速开始:`make run` → 打开 `http://<服务器IP>:7777`(默认监听 `0.0.0.0`,
适配无头服务器;默认监控本机 8080 的 SGLang,自动探测引擎;SGLang 需
`--enable-metrics` 启动。如需仅本机访问,配置里把 `server.host` 改回
`127.0.0.1`)。

## License

Apache-2.0 — see [LICENSE](LICENSE).
