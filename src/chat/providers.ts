import type { ChatConfig } from "./openai.ts";

export interface ChatProviderSpec {
  id?: string;
  name?: string;
  base_url?: string;
  api_key?: string;
  default?: boolean;
}

export interface ChatProvider {
  id: string;
  name: string;
  isDefault: boolean;
  cfg: ChatConfig;
}

const ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Turn the `chat:` config into concrete providers. With no `providers:` list a
 * single "local" provider is derived from the first monitored target (+ /v1),
 * so the monitored backend is always the default chat endpoint.
 */
export function resolveChatProviders(
  providers: ChatProviderSpec[] | undefined,
  firstTargetUrl: string,
): { list: ChatProvider[]; errors: string[] } {
  const errors: string[] = [];
  if (providers === undefined || providers.length === 0) {
    return {
      list: [
        {
          id: "local",
          name: "local",
          isDefault: true,
          cfg: { baseUrl: `${firstTargetUrl.replace(/\/+$/, "")}/v1`, apiKey: null },
        },
      ],
      errors,
    };
  }

  const list: ChatProvider[] = [];
  const seen = new Set<string>();
  providers.forEach((spec, i) => {
    const id = spec.id ?? `p${i + 1}`;
    if (!ID_RE.test(id)) {
      errors.push(`chat provider #${i + 1}: id '${id}' must match [A-Za-z0-9_-]+`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`chat provider #${i + 1}: duplicate id '${id}'`);
      return;
    }
    seen.add(id);
    const url = spec.base_url ?? "";
    if (url === "") {
      errors.push(`chat provider '${id}': base_url is required`);
      return;
    }
    const nm = spec.name ?? "";
    list.push({
      id,
      name: nm.trim() !== "" ? nm : id,
      isDefault: spec.default === true,
      cfg: { baseUrl: url, apiKey: spec.api_key ?? null },
    });
  });

  const flagged = list.filter((p) => p.isDefault);
  if (flagged.length > 1) {
    errors.push(
      `chat: only one provider may set default:true (got ${flagged.map((p) => p.id).join(", ")})`,
    );
  }
  if (list.length > 0) {
    if (flagged.length === 1) {
      for (const p of list) p.isDefault = p === flagged[0];
    } else if (flagged.length === 0) {
      list[0]!.isDefault = true;
    }
  }
  return { list, errors };
}

/** Wire shape for /api/chat/providers — deliberately carries no base_url or key. */
export interface ProviderInfo {
  id: string;
  name: string;
  default: boolean;
}

export function publicProviders(list: ChatProvider[]): {
  providers: ProviderInfo[];
  default: string;
} {
  const d = list.find((p) => p.isDefault) ?? list[0];
  return {
    providers: list.map((p) => ({ id: p.id, name: p.name, default: p.isDefault })),
    default: d?.id ?? "",
  };
}

export function pickProvider(list: ChatProvider[], id: string | null): ChatProvider | undefined {
  if (id === null || id === "") return list.find((p) => p.isDefault) ?? list[0];
  return list.find((p) => p.id === id);
}
