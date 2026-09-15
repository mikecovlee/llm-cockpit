export interface GpuSample {
  index: number;
  name: string;
  utilPct: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  tempC: number | null;
  powerW: number | null;
  powerLimitW: number | null;
}

const FIELDS = [
  "index",
  "name",
  "utilization.gpu",
  "memory.used",
  "memory.total",
  "temperature.gpu",
  "power.draw",
  "power.limit",
];

function num(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const t = cell.trim();
  if (t === "" || t.toUpperCase().startsWith("[N/A")) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

export function parseNvidiaSmiCsv(text: string): GpuSample[] {
  const out: GpuSample[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (l === "") continue;
    const c = l.split(",");
    if (c.length < 3) continue;
    const idx = num(c[0]);
    if (idx === null) continue;
    out.push({
      index: idx,
      name: (c[1] ?? "").trim(),
      utilPct: num(c[2]),
      memUsedMb: num(c[3]),
      memTotalMb: num(c[4]),
      tempC: num(c[5]),
      powerW: num(c[6]),
      powerLimitW: num(c[7]),
    });
  }
  return out;
}

/** Returns null when nvidia-smi is missing/failing/empty (no usable GPU view). */
export async function sampleGpu(): Promise<GpuSample[] | null> {
  try {
    const proc = Bun.spawn(["nvidia-smi", ...nvidiaArgs()], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 4000,
    });
    const text = await new Response(proc.stdout).text();
    const rows = parseNvidiaSmiCsv(text);
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

function nvidiaArgs(): string[] {
  return [`--query-gpu=${FIELDS.join(",")}`, "--format=csv,noheader,nounits"];
}
