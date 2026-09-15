/**
 * OpenAI-compatible chat connector. The frontend talks to /api/chat/stream on
 * our own origin (no CORS), which proxies to the configured engine.
 */

export interface ChatConfig {
  baseUrl: string; // e.g. http://127.0.0.1:8080/v1
  apiKey: string | null;
}

const CHAT_TIMEOUT_MS = 10 * 60 * 1000;

/** Combine the caller's (client-disconnect) signal with an absolute deadline;
 * without this, passing req.signal silently disabled the timeout entirely. */
function linkSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (signal === undefined) return timeout;
  if (signal.aborted) return signal;
  const ctl = new AbortController();
  signal.addEventListener("abort", () => ctl.abort(signal.reason), { once: true });
  timeout.addEventListener("abort", () => ctl.abort(timeout.reason), { once: true });
  return ctl.signal;
}

export async function chatStream(
  cfg: ChatConfig,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = CHAT_TIMEOUT_MS,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey !== null) headers["authorization"] = `Bearer ${cfg.apiKey}`;
  return fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ stream: true, ...payload }),
    signal: linkSignals(signal, timeoutMs),
  });
}

export async function listModels(cfg: ChatConfig): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cfg.apiKey !== null) headers["authorization"] = `Bearer ${cfg.apiKey}`;
  return fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/models`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
}
