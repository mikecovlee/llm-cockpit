/**
 * OpenAI-compatible chat connector. The frontend talks to /api/chat/stream on
 * our own origin (no CORS), which proxies to the configured engine.
 */

export interface ChatConfig {
  baseUrl: string; // e.g. http://127.0.0.1:8080/v1
  apiKey: string | null;
}

const CHAT_TIMEOUT_MS = 10 * 60 * 1000;

export async function chatStream(
  cfg: ChatConfig,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey !== null) headers["authorization"] = `Bearer ${cfg.apiKey}`;
  return fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ stream: true, ...payload }),
    signal: signal ?? AbortSignal.timeout(CHAT_TIMEOUT_MS),
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
