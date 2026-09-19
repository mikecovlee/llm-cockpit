import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { marked } from "marked";
import * as React from "react";
import {
  buildPayload,
  type ChatParams,
  type ChatUsage,
  copyText,
  defaultMetrics,
  defaultParams,
  formatUsage,
  loadSession,
  type MetricToggles,
  parseUsage,
  type SessionMsg,
  safeLocalStorage,
  saveSession,
  type WireMessage,
} from "./chatPayload.ts";
import { type Lang, t } from "./i18n.ts";
import { uid, useUI } from "./shared.tsx";

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  streaming?: boolean;
  images?: { id: string; url: string }[];
  usage?: ChatUsage;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function Bubble({ msg }: { msg: ChatMsg }) {
  const { lang } = useUI();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (el === null || msg.content === "") return;
    el.innerHTML = DOMPurify.sanitize(marked.parse(msg.content, { async: false }) as string);
    for (const c of Array.from(el.querySelectorAll<HTMLElement>("pre code"))) {
      hljs.highlightElement(c);
    }
    for (const pre of Array.from(el.querySelectorAll<HTMLElement>("pre"))) {
      const code = pre.querySelector("code");
      const ctl = document.createElement("div");
      ctl.className = "codectl";
      const langTag = document.createElement("span");
      langTag.textContent = code?.className.match(/language-([\w-]+)/)?.[1] ?? t(lang, "chat.code");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = t(lang, "chat.copy");
      btn.addEventListener("click", () => {
        void copyText(code?.textContent ?? "").then((ok): void => {
          if (ok) {
            btn.textContent = t(lang, "chat.copied");
            setTimeout(() => {
              btn.textContent = t(lang, "chat.copy");
            }, 1500);
          }
        });
      });
      ctl.append(langTag, btn);
      pre.insertBefore(ctl, pre.firstChild);
    }
  }, [msg.content, lang]);
  return (
    <div className={`bubble ${msg.role}`}>
      {msg.role === "user" && msg.images !== undefined && msg.images.length > 0 ? (
        <div className="thumbs">
          {msg.images.map((img) => (
            <img key={img.id} src={img.url} alt={t(lang, "chat.attachment")} className="thumb" />
          ))}
        </div>
      ) : null}
      {msg.thinking !== undefined && msg.thinking !== "" ? (
        <details className="thinking">
          <summary>{t(lang, "chat.thinking")}</summary>
          <pre>{msg.thinking}</pre>
        </details>
      ) : null}
      <div ref={ref} />
      {msg.streaming ? <span className="cursor">▍</span> : null}
    </div>
  );
}

interface ProviderInfo {
  id: string;
  name: string;
  default: boolean;
  thinking: { on: Record<string, unknown> | null; off: Record<string, unknown> | null } | null;
}

interface ProviderGroup {
  info: ProviderInfo;
  models: string[];
  error: string | null;
}

/** option value form: "<providerId>::<modelId>" — provider ids cannot contain
 * ":" (config regex), so the first "::" split is unambiguous. */
const splitSel = (v: string): { pid: string; model: string } | null => {
  const i = v.indexOf("::");
  return i < 0 ? null : { pid: v.slice(0, i), model: v.slice(i + 2) };
};

const chatErrText = (l: Lang, code: string): string =>
  code === "no models"
    ? t(l, "chat.noModels")
    : code === "unreachable"
      ? t(l, "chat.unreachable")
      : code === "api-down"
        ? t(l, "chat.apiDown")
        : code;

const initialSession = loadSession(safeLocalStorage());

const parseNum = (v: string): number | null => {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function Chat() {
  const { lang } = useUI();
  const [sel, setSel] = React.useState<string>(initialSession?.sel ?? "");
  const [groups, setGroups] = React.useState<ProviderGroup[]>([]);
  const [chatErr, setChatErr] = React.useState<string | null>(null);
  const [msgs, setMsgs] = React.useState<ChatMsg[]>(() =>
    (initialSession?.msgs ?? []).map(
      (m): ChatMsg => ({
        id: m.id,
        role: m.role,
        content: m.content,
        thinking: m.thinking,
        images: m.images?.map((u, i) => ({ id: `${m.id}-im${i}`, url: u })),
        usage: m.usage,
      }),
    ),
  );
  const [params, setParams] = React.useState<ChatParams>(initialSession?.params ?? defaultParams());
  const [metrics, setMetrics] = React.useState<MetricToggles>(
    initialSession?.metrics ?? defaultMetrics(),
  );
  const [showParams, setShowParams] = React.useState(false);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const noStreamUsage = React.useRef(new Set<string>());
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [pendingImages, setPendingImages] = React.useState<{ id: string; url: string }[]>([]);
  const [attachError, setAttachError] = React.useState<string | null>(null);

  const addFiles = (files: FileList | null): void => {
    if (files === null || files.length === 0) return;
    setAttachError(null);
    let room = 4 - pendingImages.length;
    for (const file of Array.from(files)) {
      if (room <= 0) {
        setAttachError(t(lang, "chat.tooMany"));
        break;
      }
      room -= 1;
      if (file.size > 8 * 1024 * 1024) {
        setAttachError(t(lang, "chat.tooBig", { name: file.name }));
        continue;
      }
      const reader = new FileReader();
      reader.onload = (): void => {
        if (typeof reader.result !== "string") return;
        const raw = reader.result;
        const img = new Image();
        img.onload = (): void => {
          const maxSide = Math.max(img.naturalWidth, img.naturalHeight);
          let url = raw;
          if (maxSide > 1280 || raw.length > 2 * 1024 * 1024) {
            const scale = Math.min(1, 1280 / Math.max(1, maxSide));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            const ctx = canvas.getContext("2d");
            if (ctx !== null) {
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              url = canvas.toDataURL("image/jpeg", 0.85);
            }
          }
          setPendingImages((prev) => [...prev, { id: uid(), url }].slice(0, 4));
        };
        img.onerror = (): void => {
          setAttachError(t(lang, "chat.decodeErr", { name: file.name }));
        };
        img.src = raw;
      };
      reader.readAsDataURL(file);
    }
  };

  const toContent = (
    text: string,
    images: { id: string; url: string }[],
  ): string | ContentPart[] => {
    if (images.length === 0) return text;
    const parts: ContentPart[] = images.map((p) => ({
      type: "image_url",
      image_url: { url: p.url },
    }));
    if (text !== "") parts.push({ type: "text", text });
    return parts;
  };

  React.useEffect(() => {
    let stop = false;
    void (async (): Promise<void> => {
      try {
        const pr = await fetch("/api/chat/providers");
        const pj = (await pr.json()) as { providers?: ProviderInfo[]; default?: string };
        const infos = Array.isArray(pj.providers) ? pj.providers : [];
        const loaded = await Promise.all(
          infos.map(async (info): Promise<ProviderGroup> => {
            try {
              const r = await fetch(`/api/chat/models?provider=${encodeURIComponent(info.id)}`);
              const d = (await r.json()) as {
                data?: { id: string }[];
                ok?: boolean;
                error?: string;
              };
              const ms = r.ok ? (d.data ?? []).map((m) => m.id) : [];
              return {
                info,
                models: ms,
                error: r.ok ? (ms.length === 0 ? "no models" : null) : (d.error ?? "unreachable"),
              };
            } catch {
              return { info, models: [], error: "unreachable" };
            }
          }),
        );
        if (stop) return;
        setGroups(loaded);
        const def = loaded.find((g) => g.info.id === pj.default) ?? loaded[0];
        const first = def?.models[0];
        const wanted = initialSession?.sel ?? "";
        const wantedValid =
          wanted !== "" &&
          loaded.some((g) => g.models.some((mm) => `${g.info.id}::${mm}` === wanted));
        if (!wantedValid && def !== undefined && first !== undefined) {
          setSel(`${def.info.id}::${first}`);
        }
      } catch {
        if (!stop) setChatErr("api-down");
      }
    })();
    return () => {
      stop = true;
    };
  }, []);

  const stickRef = React.useRef(true);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onScroll = (): void => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && msgs.length > 0 && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const wireFor = (list: ChatMsg[]): WireMessage[] =>
    list.map(
      (m): WireMessage => ({
        role: m.role,
        content: toContent(m.content, m.images !== undefined ? m.images : []),
      }),
    );

  const runStream = async (hist: ChatMsg[], newUser: ChatMsg | null): Promise<void> => {
    const cur = splitSel(sel);
    if (cur === null || cur.model === "") return;
    const assistantId = uid();
    const base = newUser !== null ? [...hist, newUser] : hist;
    setMsgs([...base, { id: assistantId, role: "assistant", content: "", streaming: true }]);
    setInput("");
    setPendingImages([]);
    setAttachError(null);
    setBusy(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    const grp = groups.find((g) => g.info.id === cur.pid);
    const wantUsage = !noStreamUsage.current.has(cur.pid);
    const payload = buildPayload({
      model: cur.model,
      history: wireFor(base),
      params,
      thinking: grp?.info.thinking ?? null,
      includeUsage: wantUsage,
    });
    let acc = "";
    let think = "";
    let usage: Omit<ChatUsage, "tps" | "ttftMs"> | null = null;
    let finalUsage: ChatUsage | undefined;
    const t0 = Date.now();
    let firstDeltaAt: number | null = null;
    const markDelta = (): void => {
      if (firstDeltaAt === null) firstDeltaAt = Date.now();
    };
    const finishUsage = (): void => {
      if (usage === null) return;
      const end = Date.now();
      const tps =
        usage.completion !== null && firstDeltaAt !== null && end > firstDeltaAt
          ? usage.completion / ((end - firstDeltaAt) / 1000)
          : null;
      finalUsage = {
        ...usage,
        tps,
        ttftMs: firstDeltaAt === null ? null : firstDeltaAt - t0,
      };
    };
    try {
      let r = await fetch(`/api/chat/stream?provider=${encodeURIComponent(cur.pid)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
      if (!r.ok && wantUsage) {
        const probe = await r.text().catch(() => "");
        if (/stream_options/i.test(probe)) {
          noStreamUsage.current.add(cur.pid);
          r = await fetch(`/api/chat/stream?provider=${encodeURIComponent(cur.pid)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...payload, stream_options: undefined }),
            signal: ctl.signal,
          });
        } else {
          throw new Error(`HTTP ${r.status}: ${probe.slice(0, 300)}`);
        }
      }
      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`HTTP ${r.status}: ${errText.slice(0, 300)}`);
      }
      if (r.body === null) throw new Error("no response body");
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (line === "" || !line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data) as {
              choices?: { delta?: { content?: string; reasoning_content?: string } }[];
            };
            const u = parseUsage(j);
            if (u !== null) usage = u;
            const delta = j.choices?.[0]?.delta;
            if (typeof delta?.content === "string" && delta.content !== "") {
              acc += delta.content;
              markDelta();
            }
            if (typeof delta?.reasoning_content === "string" && delta.reasoning_content !== "") {
              think += delta.reasoning_content;
              markDelta();
            }
          } catch {
            // skip malformed chunk
          }
        }
        setMsgs((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last !== undefined && last.role === "assistant") {
            next[next.length - 1] = {
              id: last.id,
              role: "assistant",
              content: acc,
              thinking: think === "" ? undefined : think,
              streaming: true,
            };
          }
          return next;
        });
      }
      finishUsage();
    } catch (e) {
      finishUsage();
      if ((e as { name?: string })?.name !== "AbortError") {
        acc =
          acc === ""
            ? `${t(lang, "chat.error")}\n\n${String(e)}`
            : `${acc}\n\n${t(lang, "chat.streamInterrupted")} ${String(e)}`;
      }
    }
    setMsgs((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last !== undefined && last.role === "assistant") {
        next[next.length - 1] = {
          id: last.id,
          role: "assistant",
          content: acc === "" ? t(lang, "chat.emptyResponse") : acc,
          thinking: think === "" ? undefined : think,
          streaming: false,
          usage: finalUsage,
        };
      }
      return next;
    });
    setBusy(false);
    abortRef.current = null;
  };

  const send = async (): Promise<void> => {
    const text = input.trim();
    const cur = splitSel(sel);
    if ((text === "" && pendingImages.length === 0) || busy || cur === null || cur.model === "")
      return;
    const newUser: ChatMsg = {
      id: uid(),
      role: "user",
      content: text,
      images: pendingImages.length > 0 ? [...pendingImages] : undefined,
    };
    await runStream(msgs, newUser);
  };

  const regenerate = async (): Promise<void> => {
    if (busy || msgs.length === 0) return;
    const idx = msgs.map((m) => m.role).lastIndexOf("assistant");
    if (idx === -1) return;
    await runStream(msgs.slice(0, idx), null);
  };

  const copyMsg = async (m: ChatMsg): Promise<void> => {
    if (await copyText(m.content)) {
      setCopiedId(m.id);
      setTimeout(() => setCopiedId(null), 1500);
    }
  };

  const newChat = (): void => {
    if (busy) return;
    setMsgs([]);
  };

  const saveNow = (): void => {
    saveSession(safeLocalStorage(), {
      v: 1,
      sel,
      params,
      metrics,
      msgs: msgs
        .filter((m) => !m.streaming)
        .map(
          (m): SessionMsg => ({
            id: m.id,
            role: m.role,
            content: m.content,
            thinking: m.thinking,
            images: m.images?.map((im) => im.url),
            usage: m.usage,
          }),
        ),
    });
  };

  const saveNowRef = React.useRef(saveNow);
  saveNowRef.current = saveNow;

  // biome-ignore lint/correctness/useExhaustiveDependencies: state deps intentionally re-arm the debounce on every chat/param change
  React.useEffect(() => {
    if (busy) return;
    const t = setTimeout(() => saveNowRef.current(), 400);
    return () => clearTimeout(t);
  }, [msgs, sel, params, metrics, busy]);

  React.useEffect(() => {
    const h = (): void => saveNowRef.current();
    window.addEventListener("pagehide", h);
    return () => window.removeEventListener("pagehide", h);
  }, []);

  const curSel = splitSel(sel);
  const curThinking =
    curSel === null ? null : (groups.find((g) => g.info.id === curSel.pid)?.info.thinking ?? null);
  const firstErr = groups[0]?.error;
  const chatHint =
    chatErr !== null
      ? chatErrText(lang, chatErr)
      : groups.length === 0
        ? t(lang, "chat.loading")
        : sel === ""
          ? firstErr !== null && firstErr !== undefined
            ? chatErrText(lang, firstErr)
            : t(lang, "chat.noUsableModel")
          : t(lang, "chat.hintOk");

  return (
    <div className="chat">
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <select
          className="sel"
          value={sel}
          onChange={(e) => setSel(e.target.value)}
          disabled={busy}
        >
          {groups.length === 0 ? (
            <option value="">
              {chatErr !== null ? chatErrText(lang, chatErr) : t(lang, "chat.loadingModels")}
            </option>
          ) : null}
          {groups.map((g) => (
            <optgroup
              key={g.info.id}
              label={
                g.error !== null ? `${g.info.name} (${chatErrText(lang, g.error)})` : g.info.name
              }
            >
              {g.models.length === 0 ? (
                <option disabled value={`${g.info.id}::`}>
                  {t(lang, "chat.noModels")}
                </option>
              ) : (
                g.models.map((m) => (
                  <option key={`${g.info.id}::${m}`} value={`${g.info.id}::${m}`}>
                    {m}
                  </option>
                ))
              )}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          className="mini-btn"
          title={t(lang, "chat.paramsTitle")}
          onClick={() => setShowParams((v) => !v)}
        >
          {t(lang, "chat.paramsBtn", { icon: showParams ? "▾" : "▸" })}
        </button>
        {msgs.length > 0 && !busy ? (
          <button type="button" className="mini-btn" onClick={newChat}>
            {t(lang, "chat.new")}
          </button>
        ) : null}
        <span className="chat-hint" style={{ marginTop: 0 }}>
          {chatHint}
        </span>
      </div>
      {showParams ? (
        <div className="popover">
          <div className="prow">
            <span>{t(lang, "chat.temperature")}</span>
            <input
              className="pin"
              type="number"
              min="0"
              max="2"
              step="0.1"
              placeholder={t(lang, "chat.placeholderDefault")}
              value={params.temperature ?? ""}
              onChange={(e) => setParams({ ...params, temperature: parseNum(e.target.value) })}
            />
          </div>
          <div className="prow">
            <span>{t(lang, "chat.topP")}</span>
            <input
              className="pin"
              type="number"
              min="0"
              max="1"
              step="0.05"
              placeholder={t(lang, "chat.placeholderDefault")}
              value={params.topP ?? ""}
              onChange={(e) => setParams({ ...params, topP: parseNum(e.target.value) })}
            />
          </div>
          <div className="prow">
            <span>{t(lang, "chat.maxTokens")}</span>
            <input
              className="pin"
              type="number"
              min="1"
              step="1"
              placeholder={t(lang, "chat.placeholderModelDefault")}
              value={params.maxTokens ?? ""}
              onChange={(e) => setParams({ ...params, maxTokens: parseNum(e.target.value) })}
            />
          </div>
          <div className="prow col">
            <span>{t(lang, "chat.systemPrompt")}</span>
            <textarea
              className="psys"
              rows={2}
              placeholder={t(lang, "chat.placeholderOptional")}
              value={params.system}
              onChange={(e) => setParams({ ...params, system: e.target.value })}
            />
          </div>
          {curThinking !== null ? (
            <div className="prow">
              <span>{t(lang, "chat.thinking")}</span>
              <label className="chk">
                <input
                  type="checkbox"
                  checked={params.thinkingOn}
                  onChange={(e) => setParams({ ...params, thinkingOn: e.target.checked })}
                />
                {params.thinkingOn ? t(lang, "chat.thinkingOn") : t(lang, "chat.thinkingOff")}
              </label>
            </div>
          ) : null}
          <div className="prow">
            <span>{t(lang, "chat.footnote")}</span>
            <div className="checks">
              {(
                [
                  ["tokens", "chat.footnoteTokens"],
                  ["tps", "chat.footnoteTps"],
                  ["ttft", "chat.footnoteTtft"],
                  ["reasoning", "chat.footnoteReasoning"],
                ] as const
              ).map(([k, labelKey]) => (
                <label key={k} className="chk">
                  <input
                    type="checkbox"
                    checked={metrics[k]}
                    onChange={(e) => setMetrics({ ...metrics, [k]: e.target.checked })}
                  />
                  {t(lang, labelKey)}
                </label>
              ))}
            </div>
          </div>
          <div className="prow">
            <button type="button" className="mini-btn" onClick={() => setParams(defaultParams())}>
              {t(lang, "chat.resetParams")}
            </button>
          </div>
        </div>
      ) : null}
      <div className="chat-msgs" ref={scrollRef}>
        {msgs.length === 0 ? <div className="empty">{t(lang, "chat.empty")}</div> : null}
        {msgs.map((m, i) => {
          const usageLine = m.usage !== undefined ? formatUsage(m.usage, metrics) : "";
          const showCopy = m.role === "assistant" && m.content !== "" && m.streaming !== true;
          const showRegen =
            m.role === "assistant" && i === msgs.length - 1 && !busy && m.streaming !== true;
          return (
            <div className="msg-wrap" key={m.id}>
              <Bubble msg={m} />
              {usageLine !== "" || showCopy || showRegen ? (
                <div className="msg-foot">
                  {usageLine !== "" ? <span>{usageLine}</span> : null}
                  {showCopy ? (
                    <button type="button" className="mini-btn" onClick={() => void copyMsg(m)}>
                      {copiedId === m.id ? t(lang, "chat.copied") : t(lang, "chat.copy")}
                    </button>
                  ) : null}
                  {showRegen ? (
                    <button type="button" className="mini-btn" onClick={() => void regenerate()}>
                      {t(lang, "chat.regenerate")}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="chat-input">
        {pendingImages.length > 0 && (
          <div className="thumbs pending">
            {pendingImages.map((p) => (
              <span key={p.id} className="thumb-wrap">
                <img src={p.url} alt={t(lang, "chat.pendingAttachment")} className="thumb" />
                <button
                  type="button"
                  className="thumb-x"
                  title={t(lang, "chat.remove")}
                  onClick={() => setPendingImages((prev) => prev.filter((q) => q.id !== p.id))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {attachError !== null && <div className="attach-error">{attachError}</div>}
        <button
          type="button"
          className="attach-btn"
          title={t(lang, "chat.attach")}
          onClick={() => fileInputRef.current?.click()}
        >
          +
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <textarea
          value={input}
          placeholder={
            sel === ""
              ? t(lang, "chat.placeholderWaiting")
              : t(lang, "chat.placeholderModel", { m: splitSel(sel)?.model ?? "" })
          }
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {busy ? (
          <button type="button" className="chat-btn stop" onClick={() => abortRef.current?.abort()}>
            {t(lang, "chat.stop")}
          </button>
        ) : (
          <button
            type="button"
            className="chat-btn"
            disabled={
              (input.trim() === "" && pendingImages.length === 0) ||
              splitSel(sel)?.model === "" ||
              splitSel(sel) === null
            }
            onClick={() => void send()}
          >
            {t(lang, "chat.send")}
          </button>
        )}
      </div>
    </div>
  );
}
