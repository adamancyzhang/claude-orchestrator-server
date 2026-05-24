import {
  type IEventBus,
  type ILogger,
  type IMessageRouter,
  type InstanceId,
  type LeaderEvent,
} from "@co/contracts";
import type { LeaderState } from "../state.js";
import type { InkTuiInstance } from "./render.js";
import type { TuiSink } from "./stubs.js";

export type { TuiSink } from "./stubs.js";

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

  async start(): Promise<void> {
    const [{ createStateStore }, { renderInkTui }] = await Promise.all([
      import("./store.js"),
      import("./render.js"),
    ]);
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
