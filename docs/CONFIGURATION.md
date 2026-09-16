# Configuration reference

Config file resolution: `$COCKPIT_CONFIG`, then `./cockpit.config.yaml`,
otherwise pure zero-config defaults. Missing/empty file is valid.
`cockpit.config.example.yaml` is a ready-to-copy template.

```yaml
server:
  host: 0.0.0.0 # bind address; 127.0.0.1 for local-only
  port: 7777 # HTTP port
  poll_interval_s: 2 # engine sampling cadence (also the chart resolution)

gpu:
  enabled: true # default: auto — probe nvidia-smi once, show the GPU card if present
```

## `targets` — monitored inference engines

```yaml
targets:
  - id: main # optional, defaults to t1, t2, ...
    url: http://127.0.0.1:8080 # engine base URL
    custom: my-engine # optional: use a custom adapter spec below instead of auto-detection
```

Without `custom`, each target is auto-detected: SGLang (answers
`/server_info`), then vLLM (answers `/version`). Detection runs once at
startup. A target whose `url` is missing/not a string is skipped with an error
log; an unreachable target keeps its card visible but reports
`engine.healthy: false`.

> SGLang's older `/get_server_info` alias is deprecated upstream (and removed
> in some gateways); llm-cockpit speaks `/server_info`, so SGLang builds from
> before that endpoint existed are not supported.

The history ring is always `poll_interval_s` × 450 samples (≈15 min at the
default). `GET /api/history?sec=` accepts 5…1800 seconds; `&compact=1`
returns chart scalars only.

## `chat` — OpenAI-compatible connectors

```yaml
chat:
  providers:
    - id: local # [A-Za-z0-9_-]+; first entry = default unless another sets default: true
      name: Local SGLang # shown in the dropdown; defaults to id
      base_url: http://127.0.0.1:8080/v1
      # api_key: sk-... # optional, sent as Authorization: Bearer; never leaves the server
    - id: deepseek
      name: DeepSeek
      base_url: https://api.deepseek.com/v1
      api_key: sk-...
      # Optional thinking on/off switch (rendered only when declared):
      thinking_toggle:
        on: { chat_template_kwargs: { enable_thinking: true } }
        off: { chat_template_kwargs: { enable_thinking: false } }
```

`thinking_toggle` fragments are merged verbatim into the request payload when
the UI switch is on/off — the shape is provider-specific. SGLang/Qwen use
`chat_template_kwargs.enable_thinking`; other providers may use their own keys
(DeepSeek selects thinking via model name instead — just omit the block).

Validation is strict: bad ids, duplicates, missing `base_url`, or several
`default: true` abort startup with actionable messages. API keys appear only
in server→provider requests; `/api/chat/providers` exposes ids/names/toggles.

Request proxying: 12 MB body cap (enforced on the socket), SSE keepalive
comments every 15 s, 10-minute absolute deadline per stream.

Zero-config default: a single provider `local` pointed at
`<first target url>/v1`.

## `custom` — declarative adapters for other engines

```yaml
custom:
  - id: my-engine
    source: prometheus # or: json
    url: http://127.0.0.1:8000/metrics # source: json -> full endpoint URL
    health: http://127.0.0.1:8000/health # optional; falls back to url
    mapping: # canonicalField -> metricName | JSONPath
      requests.running: myengine_running
      throughput.generationTps: myengine_gen_tps
      cache.kvUsagePct: myengine_kv_usage
      counts.requestsCompletedTotal: myengine_completed
      latency.ttft: myengine_ttft_seconds # Prometheus histograms: base name
      extras.power_w: myengine_power
    static:
      engine.model: my-model # JSON documents without a model field
targets:
  - id: mine
    url: http://127.0.0.1:8000
    custom: my-engine
```

Canonical field paths: `engine.{model,version}`,
`requests.{running,queued,swapped,paused}`,
`throughput.{generationTps,prefillTps,requestsPerSec,prefillEffectiveTotal}`,
`tokens.{promptTotal,generationTotal,cachedTotal}`,
`counts.requestsCompletedTotal`,
`cache.{kvUsagePct,kvUsedTokens,kvTotalTokens,hitRate,prefixHitsTotal,prefixQueriesTotal,hostUsedTokens,hostTotalTokens,kvAvailableTokens,deviceHitTotal,hostHitTotal,storageHitTotal}`,
`faults.{retractedTotal,preemptedTotal}`, `extras.<anything>`.
JSON paths support `$.a.b`, `$.a[0].b`, numeric segments as dots.

Validate a mapping live without restarting:
`POST /api/validate-mapping` (syntax check + fetch + report missing metrics —
see [../README.md](../README.md#http-api)).
