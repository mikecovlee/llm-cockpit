/** Adapter registry + auto-detection over builtin engines. */

import { sglang } from "./sglang.ts";
import type { EngineAdapter } from "./types.ts";
import { vllm } from "./vllm.ts";

export const builtins: Record<string, EngineAdapter> = { sglang, vllm };

/**
 * Probe each builtin's fingerprint endpoint. Returns the first matching
 * adapter id. Custom adapters are never auto-detected (explicit config only).
 */
export async function autoDetect(url: string): Promise<string> {
  const ids = Object.keys(builtins);
  const results = await Promise.all(
    ids.map(async (id) => {
      const a = builtins[id];
      if (a === undefined) return null;
      try {
        return (await a.detect(url)) !== null ? id : null;
      } catch {
        return null;
      }
    }),
  );
  const hit = results.find((r) => r !== null);
  if (hit === null || hit === undefined) throw new Error(`auto-detect failed for ${url}`);
  return hit;
}
