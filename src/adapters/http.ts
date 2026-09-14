/** Shared HTTP helper with a hard timeout; never throws. */

export interface HttpResponse {
  ok: boolean;
  status: number;
  text: string;
  rttMs: number;
}

const TIMEOUT_MS = 5000;

export async function fetchText(url: string, init?: RequestInit): Promise<HttpResponse> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, rttMs: performance.now() - t0 };
  } catch {
    return { ok: false, status: 0, text: "", rttMs: performance.now() - t0 };
  }
}

export function stripSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}
