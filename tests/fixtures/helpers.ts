import type { LeaderEventBus } from "../../src/leader/event-bus.js";
import type { LeaderEvent, LeaderEventType } from "../../src/types/leader.js";

export function captureEvents(bus: LeaderEventBus): LeaderEvent[] {
  const events: LeaderEvent[] = [];
  bus.onAll((e) => { events.push(e); });
  return events;
}

export function awaitEvent(
  bus: LeaderEventBus,
  type: LeaderEventType,
  timeoutMs = 1000,
): Promise<LeaderEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    bus.on(type, (e) => {
      clearTimeout(timer);
      resolve(e);
    });
  });
}

export async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
