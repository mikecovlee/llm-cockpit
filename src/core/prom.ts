/**
 * Minimal Prometheus text-format parser (openmetrics exposition).
 * Supports: gauges, counters, histograms (bucket/sum/count), untyped series,
 * escaped label values, NaN / +-Inf samples.
 */

export interface ParsedSeries {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface ParsedHistogram {
  name: string;
  labels: Record<string, string>;
  /** Finite buckets only, sorted ascending by `upper`. +Inf bucket stripped. */
  buckets: { upper: number; count: number }[];
  sum: number;
  count: number;
}

export interface Parsed {
  gauges: ParsedSeries[];
  counters: ParsedSeries[];
  histograms: ParsedHistogram[];
}

function parseNum(s: string): number {
  if (s === "NaN") return Number.NaN;
  if (s === "+Inf") return Number.POSITIVE_INFINITY;
  if (s === "-Inf") return Number.NEGATIVE_INFINITY;
  return Number(s);
}

function parseLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)="((?:[^"\\]|\\.)*)"/g;
  for (;;) {
    const m = re.exec(s);
    if (m === null) break;
    const k = m[1];
    const v = m[2];
    if (k !== undefined && v !== undefined) out[k] = v.replace(/\\(.)/gs, "$1");
  }
  return out;
}

function labelSig(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

/** Histogram join key: base name + labels excluding `le`. */
function histKey(base: string, labels: Record<string, string>): string {
  const rest: Record<string, string> = {};
  for (const k of Object.keys(labels)) {
    if (k === "le") continue;
    const v = labels[k];
    if (v !== undefined) rest[k] = v;
  }
  return base + "\x00" + labelSig(rest);
}

const SAMPLE_RE =
  /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(-?[0-9]+(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|NaN|\+Inf|-Inf)$/;

export function parsePrometheus(text: string): Parsed {
  const out: Parsed = { gauges: [], counters: [], histograms: [] };
  const typeMap = new Map<string, string>();
  const histParts = new Map<string, ParsedHistogram>();

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;

    if (line.startsWith("#")) {
      if (line.startsWith("# TYPE ")) {
        const m = line.match(/^# TYPE\s+(\S+)\s+(\S+)/);
        if (m && m[1] !== undefined && m[2] !== undefined) typeMap.set(m[1], m[2]);
      }
      continue;
    }

    const m = SAMPLE_RE.exec(line);
    if (m === null) continue;
    const name = m[1]!;
    const labels = parseLabels(m[2] ?? "");
    const value = parseNum(m[3]!);

    if (name.endsWith("_bucket")) {
      const base = name.slice(0, -"_bucket".length);
      const le = labels["le"];
      if (le === undefined) continue;
      const key = histKey(base, labels);
      let h = histParts.get(key);
      if (h === undefined) {
        h = { name: base, labels, buckets: [], sum: 0, count: 0 };
        histParts.set(key, h);
      }
      h.buckets.push({
        upper: le === "+Inf" ? Number.POSITIVE_INFINITY : parseNum(le),
        count: value,
      });
      continue;
    }

    let baseName = name;
    if (name.endsWith("_sum")) baseName = name.slice(0, -"_sum".length);
    else if (name.endsWith("_count")) baseName = name.slice(0, -"_count".length);
    if (typeMap.get(name) === "histogram" || typeMap.get(baseName) === "histogram") {
      const key = histKey(baseName, labels);
      let h = histParts.get(key);
      if (h === undefined) {
        h = { name: baseName, labels, buckets: [], sum: 0, count: 0 };
        histParts.set(key, h);
      }
      if (name.endsWith("_sum")) h.sum = value;
      else if (name.endsWith("_count")) h.count = value;
      continue;
    }

    const series: ParsedSeries = { name, labels, value };
    if (typeMap.get(name) === "counter") out.counters.push(series);
    else out.gauges.push(series);
  }

  for (const h of histParts.values()) {
    h.buckets.sort((a, b) => a.upper - b.upper);
    h.buckets = h.buckets.filter((b) => Number.isFinite(b.upper));
    out.histograms.push(h);
  }
  return out;
}

export function findSeries(
  p: Parsed,
  name: string,
  labelMatch?: Record<string, string>,
): ParsedSeries | null {
  for (const s of [...p.gauges, ...p.counters]) {
    if (s.name !== name) continue;
    if (labelMatch !== undefined && !matchesLabels(s.labels, labelMatch)) continue;
    return s;
  }
  return null;
}

export function findHistogram(
  p: Parsed,
  name: string,
  labelMatch?: Record<string, string>,
): ParsedHistogram | null {
  for (const h of p.histograms) {
    if (h.name !== name) continue;
    if (labelMatch !== undefined && !matchesLabels(h.labels, labelMatch)) continue;
    return h;
  }
  return null;
}

function matchesLabels(
  labels: Record<string, string>,
  labelMatch: Record<string, string>,
): boolean {
  return Object.entries(labelMatch).every(([k, v]) => labels[k] === v);
}
