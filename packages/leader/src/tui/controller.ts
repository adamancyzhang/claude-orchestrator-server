import {
  type IEventBus,
  type ILogger,
  type IMessageRouter,
  type InstanceId,
  type LeaderEvent,
} from "@co/contracts";
import type { LeaderState } from "../state.js";
import { createStateStore } from "./store.js";
import { renderInkTui, type InkTuiInstance } from "./render.js";

// ── Backward-compat stubs ───────────────────────────────────────────
// Ink handles stdin, stdout, and resize internally. These stubs exist
// solely so orchestrator/src/run.ts compiles unchanged.

export interface TuiSink {
  write(s: string): void;
  cols(): number;
  rows(): number;
  onResize?(cb: () => void): void;
}

export class StdoutSink implements TuiSink {
  write(_s: string): void { /* no-op: Ink writes to stdout */ }
  cols(): number { return process.stdout.columns || 120; }
  rows(): number { return process.stdout.rows || 30; }
  onResize(_cb: () => void): void { /* no-op: Ink's useWindowSize handles resize */ }
}

export class StdinKeyboardSource {
  start(): void { /* no-op: Ink's useInput handles raw mode */ }
  stop(): void { /* no-op */ }
  onInput(_cb: (input: unknown) => void): void { /* no-op */ }
}

export interface TuiControllerOptions {
  state: LeaderState;
  bus: IEventBus<LeaderEvent>;
  message_router: IMessageRouter;
  keyboard: unknown; // unused; Ink handles input via useInput
  sink: TuiSink; // unused; Ink writes to stdout directly
  logger: ILogger; // unused; Ink handles terminal errors
  leader_id: InstanceId;
  leader_name: string;
}

export class TuiController {
  private instance: InkTuiInstance | null = null;
  private exited = false;

  constructor(private readonly opts: TuiControllerOptions) {}

  start(): void {
    const store = createStateStore(this.opts.bus, this.opts.state);
    this.instance = renderInkTui({
      state: this.opts.state,
      store,
      messageRouter: this.opts.message_router,
      leaderId: this.opts.leader_id,
      leaderName: this.opts.leader_name,
    });
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    if (this.instance) {
      this.instance.store.destroy();
      this.instance.unmount();
      await this.instance.waitUntilExit;
      this.instance = null;
    }
  }
}
