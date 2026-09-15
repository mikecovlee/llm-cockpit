/**
 * Pure chat-UI logic (payload building, usage parsing, session storage) —
 * kept out of the DOM module so it is unit-testable.
 */

export interface ChatUsage {
  prompt: number | null;
  completion: number | null;
  reasoning: number | null;
  total: number | null;
  tps: number | null;
  ttftMs: number | null;
}

export interface ChatParams {
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  system: string;
  thinkingOn: boolean;
}

export interface MetricToggles {
  tokens: boolean;
  tps: boolean;
  ttft: boolean;
  reasoning: boolean;
}

export type ThinkingFragments = {
  on: Record<string, unknown> | null;
  off: Record<string, unknown> | null;
} | null;

export function defaultParams(): ChatParams {
  return { temperature: null, topP: null, maxTokens: null, system: "", thinkingOn: true };
}

export function defaultMetrics(): MetricToggles {
  return { tokens: true, tps: true, ttft: true, reasoning: true };
}

export interface WireMessage {
  role: string;
  content: unknown;
}

export function buildPayload(args: {
  model: string;
  history: WireMessage[];
  params: ChatParams;
  thinking: ThinkingFragments;
  includeUsage: boolean;
}): Record<string, unknown> {
  const system = args.params.system.trim();
  const messages: WireMessage[] =
    system === "" ? args.history : [{ role: "system", content: system }, ...args.history];
  const payload: Record<string, unknown> = { model: args.model, messages };
  const p = args.params;
  if (p.temperature !== null) payload["temperature"] = p.temperature;
  if (p.topP !== null) payload["top_p"] = p.topP;
  if (p.maxTokens !== null) payload["max_tokens"] = p.maxTokens;
  if (args.thinking !== null) {
    const frag = p.thinkingOn ? args.thinking.on : args.thinking.off;
    if (frag !== null) Object.assign(payload, frag);
  }
  if (args.includeUsage) payload["stream_options"] = { include_usage: true };
  return payload;
}

function fin(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Extract usage from a decoded SSE chunk (providers send it in a final
 * usage-only chunk when stream_options.include_usage is set). */
export function parseUsage(chunk: unknown): Omit<ChatUsage, "tps" | "ttftMs"> | null {
  const u = (chunk as { usage?: unknown })?.usage;
  if (u === null || u === undefined || typeof u !== "object") return null;
  const uu = u as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  return {
    prompt: fin(uu.prompt_tokens),
    completion: fin(uu.completion_tokens),
    total: fin(uu.total_tokens),
    reasoning: fin(uu.completion_tokens_details?.reasoning_tokens),
  };
}

const kTok = (v: number | null): string =>
  v === null
    ? "—"
    : v >= 1e6
      ? `${(v / 1e6).toFixed(1)}M`
      : v >= 1e3
        ? `${(v / 1e3).toFixed(1)}k`
        : String(v);

export function formatUsage(u: ChatUsage, m: MetricToggles): string {
  const parts: string[] = [];
  if (m.tokens) parts.push(`↑${kTok(u.prompt)} ↓${kTok(u.completion)}`);
  if (m.reasoning && u.reasoning !== null && u.reasoning > 0) parts.push(`R ${kTok(u.reasoning)}`);
  if (m.tps && u.tps !== null && u.tps > 0) parts.push(`${u.tps.toFixed(1)} tok/s`);
  if (m.ttft && u.ttftMs !== null && u.ttftMs >= 0)
    parts.push(`TTFT ${(u.ttftMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

/* ---------- session storage (best effort; never throws) ---------- */

export const SESSION_KEY = "llm-cockpit.session.v1";

export interface SessionMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  images?: string[];
  usage?: ChatUsage;
}

export interface SessionState {
  v: 1;
  sel: string;
  params: ChatParams;
  metrics: MetricToggles;
  msgs: SessionMsg[];
}

export function saveSession(raw: Storage | null, s: SessionState): boolean {
  if (raw === null) return false;
  try {
    raw.setItem(SESSION_KEY, JSON.stringify(s));
    return true;
  } catch {
    try {
      const stripped: SessionState = {
        ...s,
        msgs: s.msgs.map((m) => ({ ...m, images: undefined })),
      };
      raw.setItem(SESSION_KEY, JSON.stringify(stripped));
      return true;
    } catch {
      return false;
    }
  }
}

export function loadSession(raw: Storage | null): SessionState | null {
  if (raw === null) return null;
  let text: string | null = null;
  try {
    text = raw.getItem(SESSION_KEY);
  } catch {
    return null;
  }
  if (text === null || text === "") return null;
  try {
    const v = JSON.parse(text) as Partial<SessionState>;
    if (!Array.isArray(v.msgs)) return null;
    const msgs: SessionMsg[] = [];
    for (const m of v.msgs) {
      if (
        m !== null &&
        typeof m === "object" &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
      ) {
        msgs.push({
          id: typeof m.id === "string" ? m.id : `r-${msgs.length}`,
          role: m.role,
          content: m.content,
          thinking: typeof m.thinking === "string" ? m.thinking : undefined,
          images: Array.isArray(m.images)
            ? m.images.filter((x) => typeof x === "string")
            : undefined,
          usage: typeof m.usage === "object" && m.usage !== null ? m.usage : undefined,
        });
      }
    }
    return {
      v: 1,
      sel: typeof v.sel === "string" ? v.sel : "",
      params: {
        ...defaultParams(),
        ...(typeof v.params === "object" && v.params !== null ? v.params : {}),
      },
      metrics: {
        ...defaultMetrics(),
        ...(typeof v.metrics === "object" && v.metrics !== null ? v.metrics : {}),
      },
      msgs,
    };
  } catch {
    return null;
  }
}

export function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Clipboard with non-secure-context fallback (http://LAN has no async clipboard). */
export async function copyText(raw: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(raw);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = raw;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
