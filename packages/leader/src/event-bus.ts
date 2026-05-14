import { EventEmitter } from "node:events";
import type { IEventBus, LeaderEvent } from "@co/contracts";

const ANY = "__any__";

export class LeaderEventBus implements IEventBus<LeaderEvent> {
  private readonly emitter = new EventEmitter();

  emit(event: LeaderEvent): void {
    this.emitter.emit(event.type, event);
    this.emitter.emit(ANY, event);
  }

  on<K extends LeaderEvent["type"]>(
    type: K,
    cb: (event: Extract<LeaderEvent, { type: K }>) => void,
  ): () => void {
    const wrap = (e: LeaderEvent) =>
      cb(e as Extract<LeaderEvent, { type: K }>);
    this.emitter.on(type, wrap);
    return () => this.emitter.removeListener(type, wrap);
  }

  onAny(cb: (event: LeaderEvent) => void): () => void {
    this.emitter.on(ANY, cb);
    return () => this.emitter.removeListener(ANY, cb);
  }
}
