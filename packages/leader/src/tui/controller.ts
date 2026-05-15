import {
  PROTOCOL_VERSION,
  type IEventBus,
  type ILogger,
  type IMessageRouter,
  type InstanceId,
  type LeaderEvent,
} from "@co/contracts";
import type { TuiInput } from "./input.js";
import type { KeyboardSource } from "./input.js";
import type { LeaderState } from "../state.js";
import {
  CLEAR,
  SHOW_CURSOR,
  composeFrame,
  defaultUiState,
  type TuiUiState,
} from "./renderer.js";

export interface TuiSink {
  write(s: string): void;
  cols(): number;
  rows(): number;
  onResize?(cb: () => void): void;
}

export class StdoutSink implements TuiSink {
  write(s: string): void {
    process.stdout.write(s);
  }
  cols(): number {
    return process.stdout.columns || 120;
  }
  rows(): number {
    return process.stdout.rows || 30;
  }
  onResize(cb: () => void): void {
    process.stdout.on("resize", cb);
  }
}

export interface TuiControllerOptions {
  state: LeaderState;
  bus: IEventBus<LeaderEvent>;
  message_router: IMessageRouter;
  keyboard: KeyboardSource;
  sink: TuiSink;
  logger: ILogger;
  leader_id: InstanceId;
  leader_name: string;
  projects_root: string;
}

const SENT_INDICATOR_MS = 2000;
const RENDER_DEBOUNCE_MS = 50;

export class TuiController {
  private ui: TuiUiState = defaultUiState();
  private renderQueued = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly opts: TuiControllerOptions) {}

  start(): void {
    this.opts.keyboard.start();
    this.opts.keyboard.onInput((input) => this.handleInput(input));
    this.opts.sink.write("\x1b[?25l"); // hide cursor
    this.opts.sink.onResize?.(() => this.requestRender());

    this.unsubscribe = this.opts.bus.onAny(() => this.requestRender());
    this.refreshTimer = setInterval(() => {
      if (
        this.ui.sent_at !== null &&
        Date.now() - this.ui.sent_at > SENT_INDICATOR_MS
      ) {
        this.ui.pending_input = null;
        this.ui.sent_at = null;
      }
      this.render();
    }, 1000);

    this.render();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.opts.keyboard.stop();
    this.opts.sink.write(SHOW_CURSOR + CLEAR);
  }

  private requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setTimeout(() => {
      this.renderQueued = false;
      this.render();
    }, RENDER_DEBOUNCE_MS);
  }

  private render(): void {
    const frame = composeFrame({
      state: this.opts.state,
      ui: this.ui,
      cols: this.opts.sink.cols(),
      rows: this.opts.sink.rows(),
      now_ms: Date.now(),
      leader_name: this.opts.leader_name,
      leader_id: this.opts.leader_id,
      projects_root: this.opts.projects_root,
    });
    this.opts.sink.write(frame);
  }

  private handleInput(input: TuiInput): void {
    switch (input.type) {
      case "ctrl_c":
        process.kill(process.pid, "SIGINT");
        return;
      case "redraw":
        this.render();
        return;
      case "help_toggle":
        this.ui.show_help = !this.ui.show_help;
        this.requestRender();
        return;
      case "tab":
        if (this.opts.state.workers.length > 0) {
          this.opts.state.setSelectedWorkerIndex(
            (this.opts.state.selected_worker_index + 1) %
              this.opts.state.workers.length,
          );
          this.requestRender();
        }
        return;
      case "shift_tab":
        if (this.opts.state.workers.length > 0) {
          const next =
            (this.opts.state.selected_worker_index - 1 + this.opts.state.workers.length) %
            this.opts.state.workers.length;
          this.opts.state.setSelectedWorkerIndex(next);
          this.requestRender();
        }
        return;
      case "digit": {
        const idx = input.value - 1;
        if (idx < this.opts.state.workers.length) {
          this.opts.state.setSelectedWorkerIndex(idx);
          this.requestRender();
        }
        return;
      }
      case "char":
        this.ui.input_buffer += input.value;
        this.requestRender();
        return;
      case "backspace":
        if (this.ui.input_buffer.length > 0) {
          this.ui.input_buffer = this.ui.input_buffer.slice(0, -1);
          this.requestRender();
        }
        return;
      case "escape":
        if (this.ui.input_buffer.length > 0) {
          this.ui.input_buffer = "";
          this.requestRender();
        }
        return;
      case "enter": {
        const text = this.ui.input_buffer.trim();
        this.ui.input_buffer = "";
        if (!text) return;
        this.ui.pending_input = text;
        this.ui.sent_at = Date.now();
        void this.dispatchUserInput(text).catch((err) => {
          this.opts.logger.error("dispatch user input failed", {
            error: String(err),
          });
        });
        this.requestRender();
        return;
      }
    }
  }

  private async dispatchUserInput(content: string): Promise<void> {
    await this.opts.message_router.send({
      type: "user_input",
      from_instance: this.opts.leader_id,
      from_name: this.opts.leader_name,
      from_role: "leader",
      to_instance: this.opts.leader_id,
      content,
    });
    void PROTOCOL_VERSION; // ensure runtime keeps reference for protocol log
  }
}
