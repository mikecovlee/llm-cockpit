/** Target bookkeeping + per-target rolling snapshot ring buffer. */

import type { Snapshot } from "./model.ts";

export interface Target {
  id: string;
  url: string;
  /** Resolved adapter id (builtin or custom). */
  adapter: string;
  status: "pending" | "online" | "offline";
  model: string | null;
  version: string | null;
}

export class Ring {
  private items: Snapshot[] = [];

  constructor(private readonly capacity: number) {}

  push(s: Snapshot): void {
    this.items.push(s);
    if (this.items.length > this.capacity) this.items.shift();
  }

  latest(): Snapshot | null {
    return this.items[this.items.length - 1] ?? null;
  }

  within(sec: number, now: number = Date.now()): Snapshot[] {
    const cutoff = now - sec * 1000;
    return this.items.filter((s) => s.ts >= cutoff);
  }

  all(): Snapshot[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }
}

/** Ring capacity for a polling cadence: 15 min of points, clamped to sane bounds. */
export function ringCapacity(pollIntervalS: number): number {
  const n = Math.ceil((15 * 60) / Math.max(1, pollIntervalS));
  return Math.min(5000, Math.max(60, n));
}
