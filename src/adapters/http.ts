/** Shared HTTP helper with a hard timeout; never throws. */

export interface HttpResponse {
  ok: boolean;
  status: number;
  text: string;
  rttMs: number;
}

const TIMEOUT_MS = 5000;
const MAX_TEXT_BYTES = 32 * 1024 * 1024;

/** Streaming read with a hard byte cap; returns null when the cap is exceeded. */
async function readTextCapped(res: Response, max: number): Promise<string | null> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    if (r.value !== undefined) {
      total += r.value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      out += dec.decode(r.value, { stream: true });
    }
  }
  out += dec.decode();
  return out;
}

export async function fetchText(url: string, init?: RequestInit): Promise<HttpResponse> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const capped = await readTextCapped(res, MAX_TEXT_BYTES);
    if (capped === null) {
      return {
        ok: false,
        status: res.status,
        text: "",
        rttMs: performance.now() - t0,
      };
    }
    return { ok: res.ok, status: res.status, text: capped, rttMs: performance.now() - t0 };
  } catch {
    return { ok: false, status: 0, text: "", rttMs: performance.now() - t0 };
  }
}

export function stripSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}
