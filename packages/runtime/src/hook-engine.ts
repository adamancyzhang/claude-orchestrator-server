import { spawn, type ChildProcess } from "node:child_process";
import {
  HOOK_EVENT_TYPES,
  type HookEvent,
  type HookEventType,
  type IHookEngine,
  type ILogger,
} from "@co/contracts";

export interface HookEntry {
  event: HookEventType;
  command: string;
  enabled: boolean;
}

const HOOK_TIMEOUT_MS = 5000;

export class HookEngine implements IHookEngine {
  private readonly handlers = new Map<HookEventType, string>();
  private readonly activeHooks = new Set<ChildProcess>();

  constructor(
    entries: readonly HookEntry[],
    private readonly logger: ILogger,
  ) {
    for (const e of entries) {
      if (!HOOK_EVENT_TYPES.includes(e.event)) {
        this.logger.warn(`unknown hook event '${e.event}' — ignored`);
        continue;
      }
      if (e.enabled && e.command) this.handlers.set(e.event, e.command);
    }

    // Register cleanup so detached hooks are killed when the process exits.
    const cleanup = () => this.killAll();
    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      this.killAll();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      this.killAll();
      process.exit(143);
    });
  }

  get registered(): readonly HookEventType[] {
    return Array.from(this.handlers.keys());
  }

  async fire(event: HookEvent): Promise<void> {
    const script = this.handlers.get(event.type);
    if (!script) return;
    const envFromEvent = flattenEnv(event);

    return new Promise<void>((resolve) => {
      const child = spawn("sh", ["-c", script], {
        env: { ...process.env, CO_EVENT: event.type, ...envFromEvent },
        stdio: "ignore",
        detached: true,
      });

      this.activeHooks.add(child);

      const timer = setTimeout(() => {
        this.logger.warn(`hook ${event.type} timeout — killed`);
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, HOOK_TIMEOUT_MS);

      child.on("error", (err) => {
        clearTimeout(timer);
        this.activeHooks.delete(child);
        this.logger.warn(`hook ${event.type} failed`, {
          error: String(err),
        });
        resolve();
      });
      child.on("exit", () => {
        clearTimeout(timer);
        this.activeHooks.delete(child);
        resolve();
      });

      // Fire-and-forget: detach so caller can move on.
      child.unref();
    });
  }

  /** Kill all active hook processes. Called on process exit/signal. */
  killAll(): void {
    for (const child of this.activeHooks) {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore — process may already be gone
        }
      }
    }
    this.activeHooks.clear();
  }
}

function flattenEnv(event: HookEvent): Record<string, string> {
  const env = (event as { env: Record<string, unknown> }).env ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v === null || v === undefined ? "" : String(v);
  }
  return out;
}
