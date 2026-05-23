import { spawn } from "node:child_process";
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
        this.logger.warn(`hook ${event.type} failed`, {
          error: String(err),
        });
        resolve();
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      // Fire-and-forget: detach so caller can move on.
      child.unref();
    });
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
