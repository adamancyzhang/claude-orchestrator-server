// Test helper: records every event emitted on a LeaderEventBus so the
// e2e test can assert on the observable event stream described in
// `docs/evals/02-leader-worker-communication.md` §6 / §9 (item 11).
//
// Subscribed via `bus.onAny(...)` — the bus contract guarantees every
// `emit()` reaches the listener (packages/leader/src/event-bus.ts:9-12).

import type { LeaderEvent } from "@co/contracts";
import type { LeaderEventBus } from "@co/leader";

export interface WaitForOptions {
  /** Optional extra predicate to narrow the match. */
  predicate?: (event: LeaderEvent) => boolean;
  /** Default 5s; bump for slow flows. */
  timeout_ms?: number;
  /** How often to poll the buffer. */
  interval_ms?: number;
}

export class EventBusTap {
  private readonly buffer: LeaderEvent[] = [];
  private detach: (() => void) | null = null;

  attach(bus: LeaderEventBus): void {
    if (this.detach) throw new Error("EventBusTap already attached");
    this.detach = bus.onAny((e) => this.buffer.push(e));
  }

  stop(): void {
    this.detach?.();
    this.detach = null;
  }

  /** All recorded events in emission order. */
  events(): readonly LeaderEvent[] {
    return this.buffer;
  }

  /** Filter events by type for compact assertions. */
  by_type<K extends LeaderEvent["type"]>(
    type: K,
  ): readonly Extract<LeaderEvent, { type: K }>[] {
    return this.buffer.filter(
      (e): e is Extract<LeaderEvent, { type: K }> => e.type === type,
    );
  }

  /** Count events of a given type. */
  count(type: LeaderEvent["type"]): number {
    return this.buffer.filter((e) => e.type === type).length;
  }

  /**
   * Resolve with the first event of `type` (and matching `predicate`) that
   * arrives — including events already in the buffer. Rejects on timeout.
   */
  async wait_for<K extends LeaderEvent["type"]>(
    type: K,
    opts: WaitForOptions = {},
  ): Promise<Extract<LeaderEvent, { type: K }>> {
    const timeout = opts.timeout_ms ?? 5_000;
    const interval = opts.interval_ms ?? 25;
    const pred = opts.predicate;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const match = this.buffer.find(
        (e): e is Extract<LeaderEvent, { type: K }> =>
          e.type === type && (!pred || pred(e)),
      );
      if (match) return match;
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(
      `EventBusTap.wait_for(${type}) timed out after ${timeout}ms; ` +
        `saw ${this.buffer.length} events (types: ${[...new Set(this.buffer.map((e) => e.type))].join(",")})`,
    );
  }
}
