import { spawn } from "node:child_process";

export interface HookContext {
  instanceId: string;
  instanceName: string;
  instanceRole: string;
  messageId: string;
  messageType: string;
  messageContent: string;
  fromInstance: string;
  fromName: string;
  toInstance: string;
  workDir: string;
  link: string | null;
  logPath?: string;
  exitCode?: number;
}

export type HookEvent = "leader_message_start" | "leader_message_end" | "worker_message_start" | "worker_message_end";

export class HookEngine {
  private hooks = new Map<HookEvent, string>();

  load(config: Partial<Record<HookEvent, string | null>>): void {
    for (const [event, script] of Object.entries(config)) {
      if (script) {
        this.hooks.set(event as HookEvent, script);
      } else {
        this.hooks.delete(event as HookEvent);
      }
    }
  }

  fire(event: HookEvent, ctx: HookContext): void {
    const script = this.hooks.get(event);
    if (!script) return;

    const env: Record<string, string> = {
      CO_HOOK_EVENT: event,
      CO_INSTANCE_ID: ctx.instanceId,
      CO_INSTANCE_NAME: ctx.instanceName,
      CO_INSTANCE_ROLE: ctx.instanceRole,
      CO_MESSAGE_ID: ctx.messageId,
      CO_MESSAGE_TYPE: ctx.messageType,
      CO_MESSAGE_CONTENT: ctx.messageContent,
      CO_FROM_INSTANCE: ctx.fromInstance,
      CO_FROM_NAME: ctx.fromName,
      CO_TO_INSTANCE: ctx.toInstance,
      CO_WORK_DIR: ctx.workDir,
      CO_LINK: ctx.link ?? "",
      CO_LOG_PATH: ctx.logPath ?? "",
      CO_EXIT_CODE: ctx.exitCode?.toString() ?? "",
    };

    const child = spawn("sh", ["-c", script], {
      env: { ...process.env, ...env },
      stdio: "ignore",
      detached: true,
    });

    child.on("error", (err) => {
      console.error(`[HookEngine] ${event} hook failed: ${err.message}`);
    });

    child.unref();
  }

  get registered(): HookEvent[] {
    return Array.from(this.hooks.keys());
  }
}
