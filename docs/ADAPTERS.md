# Adding an engine

Three routes, cheapest first.

## 1. Declarative custom adapter (no code)

If the engine exposes Prometheus `/metrics` or any JSON endpoint, add a
`custom:` mapping in `cockpit.config.yaml` (full field list in
[CONFIGURATION.md](CONFIGURATION.md)). Every canonical field is optional —
the UI renders exactly what exists. Iterate safely with
`POST /api/validate-mapping`, which syntax-checks, fetches the endpoint, and
reports which mapped metrics are missing.

## 2. A real adapter (when you need detection or shaping)

Adapters live in `src/adapters/` and implement `EngineAdapter`
(`src/adapters/types.ts`):

```ts
interface EngineAdapter {
  id: string;
  detect(url: string): Promise<boolean>; // cheap identity probe
  check(url: string): Promise<boolean>; // health for this cycle
  describe?(url: string): Promise<AdapterMeta>; // model/version metadata (cached)
  sample(url: string, ts: number): Promise<Snapshot>; // one normalized snapshot
}
```

Rules:

- **Never invent defaults.** A metric the engine lacks must be `null`, so the
  card/row hides it (capability-driven UI). `emptySnapshot(ts, id)` gives the
  neutral starting point.
- Prometheus: `parsePrometheus(text)`, then `gauge`/`counter`/`histogram`
  helpers. Counters and additive gauges **must** go through `sumSeries`
  (`counter()`) — engines split series by labels (`is_streaming`,
  `cache_source`, `mode`, `dp_rank`…); percentages stay first-series.
  Histograms merge across label splits automatically in `findHistogram`.
- Derive nothing here that `deriveRates` computes (rates, cumulative hit
  ratio) — map raw totals, let the poll loop derive.

Wire it up: export from the adapter file, add to `builtins` and the
`autoDetect` order in `src/adapters/index.ts`, extend `test/<engine>.test.ts`
with a realistic fixture captured from a live engine
(`curl -s <engine>/metrics > test/fixtures/<engine>/metrics.txt`, trim to the
relevant families).

## 3. Chat side

Nothing to do: any OpenAI-compatible `/v1` endpoint is a chat provider via
config. Providers with nonstandard extras (thinking toggles) declare payload
fragments; see [CONFIGURATION.md](CONFIGURATION.md#chat--openai-compatible-connectors).
