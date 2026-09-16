# Changelog

All notable changes to **llm-cockpit** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- SGLang adapter now queries `/server_info` instead of the upstream-deprecated
  `/get_server_info` (deprecated alias already removed in some gateway
  deployments; the old path also logged a deprecation warning on every poll).
  SGLang builds predating `/server_info` are no longer supported.

## [0.2.0] - 2026-09-15

### Added
- Bilingual UI (English/中文): browser-language auto-detect, one-tap header
  toggle, persisted preference. Technical terms (TTFT, tok/s, KV) stay English
  in both languages.
- Light & dark themes: follow system `prefers-color-scheme` on first visit,
  one-tap header toggle, persisted. Charts, vendored code-highlighting
  (github-dark/github-light), GPU sparklines and every surface are theme-aware;
  applied pre-paint by an inline script (no flash of the wrong theme).
- `scripts/qa-theme.mjs`: 8-combination matrix (theme × language × width)
  asserting localized labels, WCAG contrast ≥ 4.5, sticky-header spacing and
  toggle persistence.

### Fixed
- Sticky header had zero bottom margin and an over-transparent background, so
  page content visibly touched and bled through its edge — now 12px spacing,
  0.94-alpha backdrop and a subtle shadow.

## [0.1.2] - 2026-09-15

First release with downloadable artifacts + container image.

### Fixed
- release asset upload used the raw `upload_url` (which carries a `{name}`
  template) and 404'd — v0.1.1 ended up with an asset-less release. The
  release tool now strips the template and lives in `scripts/release.mjs`,
  where every API failure is logged explicitly.

## [0.1.1] - 2026-09-15

Rolled up the aborted v0.1.0 tag (release-notes extraction treated the version
bracket as a regex class). This tag created the GitHub Release but its asset
upload failed (fixed in 0.1.2).

### Fixed
- Server no longer exits when every configured target is unreachable — the
  cockpit boots with an empty dashboard and the chat keeps working (Docker
  deployments on bridge networks hit this with the zero-config default target)

## [0.1.0] - 2026-09-15

First public release.

### Added

- **Metrics cockpit** for LLM inference engines: requests, throughput, KV cache
  (incl. host/L2 tier), latency histograms (TTFT/E2E/TPOT/queue, p50/p90/p99),
  cumulative token/fault counters, and a live GPU panel (utilization, memory,
  temperature, power) — 15-minute window, 2 s refresh, capability-driven UI
  (metrics an engine does not report simply do not render).
- **Engine adapters**: built-in SGLang and vLLM detection/normalization plus
  declarative **custom adapters** (Prometheus metric mapping or JSON paths) —
  supporting a new engine needs no code for the common cases.
- **OpenAI-compatible chat** with streaming, markdown + syntax highlighting,
  collapsible reasoning ("thinking") blocks, image attachments (browser-side
  downscaling), per-message performance footnotes (tokens, tok/s, TTFT),
  regenerate/copy, and per-session parameters (temperature/top_p/max tokens/
  system prompt, plus an optional thinking toggle).
- **Multiple chat providers** (`chat.providers`) with one grouped dropdown;
  the monitored engine is the zero-config default. API keys never leave the
  server.
- **Session persistence** via browser localStorage (quota-safe image degrade);
  the server stores nothing.
- Robust chat proxy: SSE keepalive pings, 10-minute upstream deadline,
  12 MB request cap enforced on the socket.
- Single Bun process, zero runtime deps: `make run`, `make image`,
  `make binary`; brotli/gzip-negotiated assets, content-hashed JS cached
  immutable.
- CI (tests + typecheck + lint + build), bilingual README (EN + zh-CN),
  configuration/adapter/architecture docs, container-only dev toolchain.
