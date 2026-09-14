import type { Snapshot } from "../core/model.ts";

export interface AdapterMeta {
  model: string | null;
  version: string | null;
}

/**
 * An engine adapter normalizes one engine's endpoints into the canonical
 * Snapshot. `detect` is a cheap fingerprint probe used for auto-detection
 * and returns null when the URL is not this engine.
 */
export interface EngineAdapter {
  readonly id: string;
  detect(url: string): Promise<string | null>;
  check(url: string): Promise<boolean>;
  describe(url: string): Promise<AdapterMeta>;
  sample(url: string, ts: number): Promise<Snapshot>;
}
