/**
 * UI copy for the monitor + chat views (en/zh dictionaries).
 *
 * `en` is the source of truth for key names; `zh` must cover exactly the same
 * keys (enforced by `LangKey` and the parity test in test/i18n.test.ts).
 * `t()` resolves a key for the given language and replaces `{var}` tokens
 * with values from `vars`.
 *
 * Terminology policy: technical terms (TTFT, TPOT, tok/s, KV, top_p, …) keep
 * their English form in both languages; only interface wording is translated.
 */

export type Lang = "en" | "zh";

export const en = {
  /* ---------- header + app-level ---------- */
  "app.title": "LLM Cockpit",
  "nav.monitor": "monitor",
  "nav.chat": "chat",
  "hdr.toZh": "Switch to Chinese",
  "hdr.toEn": "Switch to English",
  "hdr.toLight": "Switch to light theme",
  "hdr.toDark": "Switch to dark theme",
  "target.none": "no target",
  "target.online": "online",
  "target.pending": "pending",
  "target.offline": "offline",
  "banner.apiDown": "cannot reach llm-cockpit API",
  "banner.noTargets": "no targets configured — add one to cockpit.config.yaml",
  "banner.engineDown":
    "engine unreachable — is it running? if metrics are missing, start it with --enable-metrics",

  /* ---------- requests card ---------- */
  "requests.title": "requests",
  "requests.running": "running",
  "requests.queued": "queued",
  "requests.paused": "paused",
  "requests.swapped": "swapped",

  /* ---------- throughput card ---------- */
  "throughput.title": "throughput",
  "throughput.generation": "generation",
  "throughput.prefill": "prefill",
  "throughput.tokPerSec": "tok/s",
  "throughput.rps": "requests",
  "throughput.estCompute": "est. compute (all GPUs)",
  "throughput.estMemBw": "est. mem bandwidth",
  "throughput.seriesGen": "generation tok/s",
  "throughput.seriesPrefill": "prefill tok/s",
  "throughput.seriesPrefillEff": "prefill effective tok/s",

  /* ---------- kv cache card ---------- */
  "kv.title": "kv cache",
  "kv.empty": "no kv data",
  "kv.usedTotal": "used / total",
  "kv.hitRate": "cache hit rate",
  "kv.available": "KV available",
  "kv.hits": "hits dev/host/storage tok/s",
  "kv.hostTier": "host tier (L2)",
  "kv.seriesUsage": "kv usage %",
  "kv.seriesHostTier": "host tier %",

  /* ---------- latency card ---------- */
  "latency.title": "latency (s)",
  "latency.empty": "no latency data",
  "latency.ttftP50": "TTFT p50",
  "latency.ttftP90": "TTFT p90",
  "latency.ttftP99": "TTFT p99",
  "latency.ttftP9099": "TTFT p90 / p99",
  "latency.e2eP5099": "E2E p50 / p99",
  "latency.tpotP50": "TPOT p50",
  "latency.queueP50": "queue wait p50",

  /* ---------- tokens card ---------- */
  "tokens.title": "tokens (cumulative)",
  "tokens.prompt": "prompt",
  "tokens.generation": "generation",
  "tokens.cached": "cached",
  "tokens.completed": "requests completed",

  /* ---------- faults card ---------- */
  "faults.title": "faults",
  "faults.retracted": "retracted",
  "faults.preempted": "preempted",
  "faults.caption": "cumulative since engine start",

  /* ---------- extras card ---------- */
  "extras.title": "extras",
  "extras.mambaOccupancy": "mamba occupancy",
  "extras.hicacheLoadBack": "hicache load-back tokens",
  "extras.fwdOccupancy": "forward occupancy",
  "extras.mambaSlots": "mamba slots available",
  "extras.specAccept": "spec accept rate / len",
  "extras.empty": "no data",

  /* ---------- engine card ---------- */
  "engine.title": "engine",
  "engine.adapter": "adapter",
  "engine.model": "model",
  "engine.version": "version",
  "engine.rtt": "probe rtt",
  "engine.url": "url",

  /* ---------- gpu card ---------- */
  "gpu.title": "gpu × {count}",
  "gpu.row": "GPU {index}",
  "gpu.util": "{pct}% util",
  "gpu.memory": "memory",
  "gpu.tempPower": "temp · power",
  "gpu.sparkCap": "util · mem %",
  "gpu.sparkTitle": "GPU utilization and memory over time",

  /* ---------- chat ---------- */
  "chat.loadingModels": "loading models…",
  "chat.noModels": "no models",
  "chat.unreachable": "unreachable",
  "chat.apiDown": "cannot reach chat API",
  "chat.loading": "loading…",
  "chat.noUsableModel": "no usable model",
  "chat.hintOk": "OpenAI-compatible · ⏎ send · ⇧⏎ newline",
  "chat.paramsTitle": "chat parameters",
  "chat.paramsBtn": "params {icon}",
  "chat.new": "new",
  "chat.temperature": "temperature",
  "chat.topP": "top_p",
  "chat.maxTokens": "max tokens",
  "chat.placeholderDefault": "default",
  "chat.placeholderModelDefault": "model default",
  "chat.systemPrompt": "system prompt",
  "chat.placeholderOptional": "optional",
  "chat.thinking": "thinking",
  "chat.thinkingOn": "on",
  "chat.thinkingOff": "off",
  "chat.footnote": "footnote",
  "chat.footnoteTokens": "tokens",
  "chat.footnoteTps": "tok/s",
  "chat.footnoteTtft": "TTFT",
  "chat.footnoteReasoning": "reasoning",
  "chat.resetParams": "reset params",
  "chat.empty": "ask anything — chat is proxied to the selected provider",
  "chat.copy": "copy",
  "chat.copied": "copied",
  "chat.regenerate": "regenerate",
  "chat.placeholderWaiting": "waiting for model list…",
  "chat.placeholderModel": "message {model}…",
  "chat.remove": "remove",
  "chat.pendingAttachment": "pending attachment",
  "chat.attach": "attach image",
  "chat.attachment": "attachment",
  "chat.stop": "stop",
  "chat.send": "send",
  "chat.tooMany": "Up to 4 images per message.",
  "chat.tooBig": "{name} exceeds 8MB — skipped.",
  "chat.decodeErr": "{name} could not be decoded — skipped.",
  "chat.error": "**error**",
  "chat.streamInterrupted": "**[stream interrupted]**",
  "chat.emptyResponse": "*(empty response)*",
  "chat.code": "code",
} as const satisfies Record<string, string>;

export type LangKey = keyof typeof en;

export const zh: Record<LangKey, string> = {
  /* ---------- header + app-level ---------- */
  "app.title": "LLM Cockpit",
  "nav.monitor": "监控",
  "nav.chat": "对话",
  "hdr.toZh": "切换到中文",
  "hdr.toEn": "切换到英文",
  "hdr.toLight": "切换为亮色主题",
  "hdr.toDark": "切换为暗色主题",
  "target.none": "无目标",
  "target.online": "在线",
  "target.pending": "待连接",
  "target.offline": "离线",
  "banner.apiDown": "无法连接 llm-cockpit API",
  "banner.noTargets": "未配置目标 — 请在 cockpit.config.yaml 中添加一个",
  "banner.engineDown": "无法连接引擎 — 它正在运行吗？若缺少指标，请加上 --enable-metrics 启动",

  /* ---------- requests card ---------- */
  "requests.title": "请求",
  "requests.running": "运行中",
  "requests.queued": "排队中",
  "requests.paused": "已暂停",
  "requests.swapped": "已换出",

  /* ---------- throughput card ---------- */
  "throughput.title": "吞吐",
  "throughput.generation": "生成",
  "throughput.prefill": "预填充",
  "throughput.tokPerSec": "tok/s",
  "throughput.rps": "请求",
  "throughput.estCompute": "估算算力（全部 GPU）",
  "throughput.estMemBw": "估算内存带宽",
  "throughput.seriesGen": "生成 tok/s",
  "throughput.seriesPrefill": "预填充 tok/s",
  "throughput.seriesPrefillEff": "预填充有效 tok/s",

  /* ---------- kv cache card ---------- */
  "kv.title": "KV Cache",
  "kv.empty": "无 KV 数据",
  "kv.usedTotal": "已用 / 总量",
  "kv.hitRate": "缓存命中率",
  "kv.available": "KV 可用",
  "kv.hits": "dev/host/storage 命中 tok/s",
  "kv.hostTier": "主机层 (L2)",
  "kv.seriesUsage": "KV 使用率 %",
  "kv.seriesHostTier": "主机层 %",

  /* ---------- latency card ---------- */
  "latency.title": "延迟 (s)",
  "latency.empty": "无延迟数据",
  "latency.ttftP50": "TTFT p50",
  "latency.ttftP90": "TTFT p90",
  "latency.ttftP99": "TTFT p99",
  "latency.ttftP9099": "TTFT p90 / p99",
  "latency.e2eP5099": "E2E p50 / p99",
  "latency.tpotP50": "TPOT p50",
  "latency.queueP50": "排队等待 p50",

  /* ---------- tokens card ---------- */
  "tokens.title": "Token（累计）",
  "tokens.prompt": "Prompt",
  "tokens.generation": "生成",
  "tokens.cached": "已缓存",
  "tokens.completed": "已完成请求",

  /* ---------- faults card ---------- */
  "faults.title": "故障",
  "faults.retracted": "已撤回",
  "faults.preempted": "被抢占",
  "faults.caption": "引擎启动以来累计",

  /* ---------- extras card ---------- */
  "extras.title": "扩展指标",
  "extras.mambaOccupancy": "Mamba 占用率",
  "extras.hicacheLoadBack": "HiCache 回读 Token",
  "extras.fwdOccupancy": "前向占用率",
  "extras.mambaSlots": "可用 Mamba 槽",
  "extras.specAccept": "投机接受率 / 长度",
  "extras.empty": "无数据",

  /* ---------- engine card ---------- */
  "engine.title": "引擎",
  "engine.adapter": "适配器",
  "engine.model": "模型",
  "engine.version": "版本",
  "engine.rtt": "探测 RTT",
  "engine.url": "URL",

  /* ---------- gpu card ---------- */
  "gpu.title": "GPU × {count}",
  "gpu.row": "GPU {index}",
  "gpu.util": "{pct}% 利用率",
  "gpu.memory": "显存",
  "gpu.tempPower": "温度 · 功耗",
  "gpu.sparkCap": "利用率 · 显存 %",
  "gpu.sparkTitle": "GPU 利用率与显存随时间变化",

  /* ---------- chat ---------- */
  "chat.loadingModels": "加载模型中…",
  "chat.noModels": "无模型",
  "chat.unreachable": "无法连接",
  "chat.apiDown": "无法连接聊天 API",
  "chat.loading": "加载中…",
  "chat.noUsableModel": "无可用模型",
  "chat.hintOk": "OpenAI 兼容 · ⏎ 发送 · ⇧⏎ 换行",
  "chat.paramsTitle": "对话参数",
  "chat.paramsBtn": "参数 {icon}",
  "chat.new": "新建",
  "chat.temperature": "温度",
  "chat.topP": "top_p",
  "chat.maxTokens": "最大 Token",
  "chat.placeholderDefault": "默认",
  "chat.placeholderModelDefault": "模型默认值",
  "chat.systemPrompt": "系统提示",
  "chat.placeholderOptional": "可选",
  "chat.thinking": "思考",
  "chat.thinkingOn": "开",
  "chat.thinkingOff": "关",
  "chat.footnote": "脚注",
  "chat.footnoteTokens": "Token",
  "chat.footnoteTps": "tok/s",
  "chat.footnoteTtft": "TTFT",
  "chat.footnoteReasoning": "推理",
  "chat.resetParams": "重置参数",
  "chat.empty": "随便问点什么 — 对话将转发到所选提供商",
  "chat.copy": "复制",
  "chat.copied": "已复制",
  "chat.regenerate": "重新生成",
  "chat.placeholderWaiting": "等待模型列表…",
  "chat.placeholderModel": "向 {model} 发消息…",
  "chat.remove": "移除",
  "chat.pendingAttachment": "待发送附件",
  "chat.attach": "附加图片",
  "chat.attachment": "附件",
  "chat.stop": "停止",
  "chat.send": "发送",
  "chat.tooMany": "每条消息最多 4 张图片。",
  "chat.tooBig": "「{name}」超过 8MB — 已跳过。",
  "chat.decodeErr": "「{name}」无法解码 — 已跳过。",
  "chat.error": "**错误**",
  "chat.streamInterrupted": "**[流已中断]**",
  "chat.emptyResponse": "*(空响应)*",
  "chat.code": "代码",
};

/** Resolve `key` for `lang`, replacing every `{name}` token with `vars[name]`. */
export function t(lang: Lang, key: LangKey, vars?: Record<string, string | number>): string {
  let out: string = lang === "zh" ? zh[key] : en[key];
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) {
      out = out.replaceAll(`{${name}}`, String(value));
    }
  }
  return out;
}
