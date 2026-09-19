import type * as React from "react";
import { CHART, LineChart, type Series, Spark } from "./charts.tsx";
import { t } from "./i18n.ts";
import { Card, fmtNum, fmtPct, fmtTime, fmtTok, Row, Stat, useUI } from "./shared.tsx";
import type { ChartPoint, GpuSeries, GpuState, Snapshot, Target } from "./types.ts";

function quantile(b: { upper: number; count: number }[], total: number, q: number): number | null {
  if (!(total > 0) || !(q > 0 && q <= 1) || b.length === 0) return null;
  const target = q * total;
  let prevCount = 0;
  let prevUpper = 0;
  for (const bucket of b) {
    if (bucket.count >= target) {
      const width = bucket.count - prevCount;
      if (width <= 0) return bucket.upper;
      return prevUpper + (bucket.upper - prevUpper) * ((target - prevCount) / width);
    }
    prevCount = bucket.count;
    prevUpper = bucket.upper;
  }
  const last = b[b.length - 1]!;
  return last.upper;
}

function hq(h: Snapshot["latency"]["ttft"]): {
  p50: number | null;
  p90: number | null;
  p99: number | null;
  mean: number | null;
} {
  if (h === null || h.count <= 0) return { p50: null, p90: null, p99: null, mean: null };
  return {
    p50: quantile(h.buckets, h.count, 0.5),
    p90: quantile(h.buckets, h.count, 0.9),
    p99: quantile(h.buckets, h.count, 0.99),
    mean: h.sum / h.count,
  };
}

function GpuCard({ gpu, hist }: { gpu: GpuState; hist: Record<number, GpuSeries> }) {
  const { lang } = useUI();
  return (
    <Card title={t(lang, "gpu.title", { count: gpu.gpus.length })}>
      {gpu.gpus.map((g) => (
        <div key={g.index} className="gpu-row">
          <Row
            label={`${t(lang, "gpu.row", { index: g.index })}${g.name === "" ? "" : ` · ${g.name}`}`}
            value={g.utilPct === null ? "—" : t(lang, "gpu.util", { pct: g.utilPct })}
          />
          <div className="bar">
            <div style={{ width: `${Math.min(100, g.utilPct ?? 0).toFixed(0)}%` }} />
          </div>
          <Row
            label={t(lang, "gpu.memory")}
            value={
              g.memUsedMb !== null && g.memTotalMb !== null
                ? `${(g.memUsedMb / 1024).toFixed(1)} / ${(g.memTotalMb / 1024).toFixed(1)} GB`
                : "—"
            }
          />
          <Row
            label={t(lang, "gpu.tempPower")}
            value={`${g.tempC === null ? "—" : `${g.tempC}°C`} · ${g.powerW === null ? "—" : `${g.powerW.toFixed(0)}W`}`}
          />
          <Spark a={hist[g.index]?.util ?? []} b={hist[g.index]?.mem ?? []} />
          <div className="spark-cap">{t(lang, "gpu.sparkCap")}</div>
        </div>
      ))}
    </Card>
  );
}

export function MonitorView({
  snap,
  history,
  gpu,
  gpuHist,
  target,
}: {
  snap: Snapshot | null;
  history: ChartPoint[];
  gpu: GpuState | null;
  gpuHist: Record<number, GpuSeries>;
  target: Target | null;
}): React.ReactElement {
  const { lang, theme } = useUI();
  const labels = history.map((s) => fmtTime(s.ts, lang));
  const g = (pick: (s: ChartPoint) => number | null): (number | null)[] => history.map(pick);
  const hasValue = (pick: (s: ChartPoint) => number | null): boolean =>
    history.some((s) => pick(s) !== null);
  const hasAny = (pred: (s: ChartPoint) => boolean): boolean => history.some((s) => pred(s));

  const c = CHART[theme];
  const requestSeries: Series[] = [
    { name: t(lang, "requests.running"), data: g((s) => s.requests.running), color: c.blue },
    { name: t(lang, "requests.queued"), data: g((s) => s.requests.queued), color: c.amber },
  ];

  const tpSeries: Series[] = [
    {
      name: t(lang, "throughput.seriesGen"),
      data: g((s) => s.throughput.generationTps),
      color: c.green,
    },
  ];
  if (hasValue((s) => s.throughput.prefillTps)) {
    tpSeries.push({
      name: t(lang, "throughput.seriesPrefill"),
      data: g((s) => s.throughput.prefillTps),
      color: c.orange,
    });
  }

  const kvSeries: Series[] = [
    {
      name: t(lang, "kv.seriesUsage"),
      data: g((s) => (s.cache.kvUsagePct === null ? null : s.cache.kvUsagePct * 100)),
      color: c.violet,
    },
  ];

  const ttftSeries: Series[] = hasAny((s) => s.latency.ttft !== null)
    ? [
        {
          name: t(lang, "latency.ttftP50"),
          data: g((s) => s.latency.ttft?.p50 ?? null),
          color: c.blue,
        },
        {
          name: t(lang, "latency.ttftP90"),
          data: g((s) => s.latency.ttft?.p90 ?? null),
          color: c.amber,
        },
        {
          name: t(lang, "latency.ttftP99"),
          data: g((s) => s.latency.ttft?.p99 ?? null),
          color: c.red,
        },
      ]
    : [];

  const lq =
    snap === null
      ? null
      : {
          ttft: hq(snap.latency.ttft),
          e2e: hq(snap.latency.e2e),
          tpot: hq(snap.latency.tpot),
          queue: hq(snap.latency.queueWait),
        };

  const kv = snap === null ? null : snap.cache;
  const kvPct = kv !== null && kv.kvUsagePct !== null ? kv.kvUsagePct : null;
  const hitRate = kv !== null ? (kv.cumulativeHitRate ?? kv.hitRate) : null;
  const extraEntries =
    snap === null ? [] : Object.entries(snap.extras).filter(([, v]) => v !== null);

  return (
    <>
      <section className="grid4">
        <Card title={t(lang, "requests.title")}>
          <div className="stats">
            <Stat
              label={t(lang, "requests.running")}
              value={fmtNum(snap?.requests.running ?? null, 0)}
            />
            <Stat
              label={t(lang, "requests.queued")}
              value={fmtNum(snap?.requests.queued ?? null, 0)}
            />
            {snap !== null && snap.requests.utilization !== null ? (
              <Stat
                label={t(lang, "requests.utilization")}
                value={fmtPct(snap.requests.utilization)}
              />
            ) : null}
          </div>
          <LineChart series={requestSeries} labels={labels} />
        </Card>

        <Card title={t(lang, "throughput.title")}>
          <div className="stats">
            <Stat
              label={t(lang, "throughput.generation")}
              value={fmtNum(snap?.throughput.generationTps ?? null)}
              sub={t(lang, "throughput.tokPerSec")}
            />
            {snap !== null && snap.throughput.prefillTps !== null ? (
              <Stat
                label={t(lang, "throughput.prefill")}
                value={fmtNum(snap.throughput.prefillTps)}
                sub={t(lang, "throughput.tokPerSec")}
              />
            ) : null}
          </div>
          {snap !== null && snap.throughput.requestsPerSec !== null ? (
            <Row
              label={t(lang, "throughput.rps")}
              value={`${snap.throughput.requestsPerSec.toFixed(2)} req/s`}
            />
          ) : null}
          <LineChart series={tpSeries} labels={labels} />
        </Card>

        <Card title={t(lang, "kv.title")}>
          {kvPct === null ? (
            <div className="empty">{t(lang, "kv.empty")}</div>
          ) : (
            <>
              <div className="big">{(kvPct * 100).toFixed(1)}%</div>
              <div className="bar">
                <div style={{ width: `${Math.min(100, kvPct * 100).toFixed(1)}%` }} />
              </div>
              {kv !== null ? (
                <>
                  <Row
                    label={t(lang, "kv.usedTotal")}
                    value={`${fmtTok(kv.kvUsedTokens)} / ${fmtTok(kv.kvTotalTokens)}`}
                  />
                  <Row label={t(lang, "kv.hitRate")} value={fmtPct(hitRate)} />
                  {kv.evictedTokensTotal !== null ? (
                    <Row label={t(lang, "kv.evicted")} value={fmtTok(kv.evictedTokensTotal)} />
                  ) : null}
                </>
              ) : null}
            </>
          )}
          <LineChart series={kvSeries} labels={labels} />
        </Card>

        <Card title={t(lang, "latency.title")}>
          {lq !== null ? (
            <>
              <div className="big">{lq.ttft.p50 === null ? "—" : `${lq.ttft.p50.toFixed(2)}s`}</div>
              <div className="stat-label">{t(lang, "latency.ttftP50")}</div>
              <Row
                label={t(lang, "latency.ttftP9099")}
                value={`${lq.ttft.p90 === null ? "—" : lq.ttft.p90.toFixed(2)} / ${lq.ttft.p99 === null ? "—" : lq.ttft.p99.toFixed(2)}`}
              />
              <Row
                label={t(lang, "latency.e2eP5099")}
                value={`${lq.e2e.p50 === null ? "—" : lq.e2e.p50.toFixed(2)} / ${lq.e2e.p99 === null ? "—" : lq.e2e.p99.toFixed(2)}`}
              />
              <Row
                label={t(lang, "latency.tpotP50")}
                value={lq.tpot.p50 === null ? "—" : lq.tpot.p50.toFixed(3)}
              />
              <Row
                label={t(lang, "latency.queueP50")}
                value={lq.queue.p50 === null ? "—" : lq.queue.p50.toFixed(3)}
              />
            </>
          ) : (
            <div className="empty">{t(lang, "latency.empty")}</div>
          )}
          <LineChart
            series={
              ttftSeries.length > 0
                ? ttftSeries
                : [{ name: t(lang, "latency.ttftP50"), data: [], color: c.blue }]
            }
            labels={labels}
          />
        </Card>
      </section>

      <section className="grid5">
        <Card title={t(lang, "tokens.title")}>
          <Row label={t(lang, "tokens.prompt")} value={fmtTok(snap?.tokens.promptTotal ?? null)} />
          <Row
            label={t(lang, "tokens.generation")}
            value={fmtTok(snap?.tokens.generationTotal ?? null)}
          />
          <Row label={t(lang, "tokens.cached")} value={fmtTok(snap?.tokens.cachedTotal ?? null)} />
          <Row
            label={t(lang, "tokens.completed")}
            value={fmtNum(snap?.counts.requestsCompletedTotal ?? null, 0)}
          />
        </Card>

        <Card title={t(lang, "faults.title")}>
          <div className="stats">
            <Stat
              label={t(lang, "faults.retracted")}
              value={fmtNum(snap?.faults.retractedTotal ?? null, 0)}
            />
            <Stat
              label={t(lang, "faults.preempted")}
              value={fmtNum(snap?.faults.preemptedTotal ?? null, 0)}
            />
            <Stat
              label={t(lang, "faults.aborted")}
              value={fmtNum(snap?.faults.abortedTotal ?? null, 0)}
            />
          </div>
          <div className="caption">{t(lang, "faults.caption")}</div>
        </Card>

        {extraEntries.length > 0 ? (
          <Card title={t(lang, "extras.title")}>
            {extraEntries.map(([k, v]) => (
              <Row key={k} label={k} value={fmtNum(v, 2)} />
            ))}
          </Card>
        ) : null}

        <Card title={t(lang, "engine.title")}>
          <Row
            label={t(lang, "engine.adapter")}
            value={snap?.engine.adapter ?? target?.adapter ?? "—"}
          />
          <Row label={t(lang, "engine.model")} value={snap?.engine.model ?? target?.model ?? "—"} />
          <Row
            label={t(lang, "engine.version")}
            value={snap?.engine.version ?? target?.version ?? "—"}
          />
          <Row label={t(lang, "engine.rtt")} value={`${snap?.engine.rttMs ?? 0}ms`} />
          <Row label={t(lang, "engine.url")} value={target?.url ?? "—"} />
        </Card>
        {gpu !== null && gpu.available ? <GpuCard gpu={gpu} hist={gpuHist} /> : null}
      </section>
    </>
  );
}
