import { spawn, type ChildProcess } from "child_process";
import { ZkClient } from "../zk/client.js";
import * as paths from "../zk/paths.js";
import { MessageSchema, type Message } from "../models/schemas.js";

interface WatchedInstance {
  workDir: string;
  queue: Message[];
  processing: boolean;
  stopped: boolean;
  child: ChildProcess | null;
  inFlight: Set<string>;
}

export class MessageWatcher {
  private instances = new Map<string, WatchedInstance>();

  constructor(private zk: ZkClient) {}

  async startWatching(instanceId: string, workDir: string): Promise<void> {
    this.stopWatching(instanceId);
    await this.zk.mkdirp(paths.messageDirPath(instanceId));
    const state: WatchedInstance = {
      workDir,
      queue: [],
      processing: false,
      stopped: false,
      child: null,
      inFlight: new Set(),
    };
    this.instances.set(instanceId, state);
    console.log(
      `[MessageWatcher] Started watching ${instanceId.slice(0, 8)} at ${workDir}`
    );
    await this._watchLoop(instanceId);
  }

  stopWatching(instanceId: string): void {
    const state = this.instances.get(instanceId);
    if (!state) return;
    state.stopped = true;
    if (state.child) {
      state.child.kill("SIGTERM");
      state.child = null;
    }
    this.instances.delete(instanceId);
    console.log(
      `[MessageWatcher] Stopped watching ${instanceId.slice(0, 8)}`
    );
  }

  stopAll(): void {
    for (const id of this.instances.keys()) {
      this.stopWatching(id);
    }
  }

  private async _watchLoop(instanceId: string): Promise<void> {
    const state = this.instances.get(instanceId);
    if (!state || state.stopped) return;

    try {
      const children = await this.zk.watchMessageDir(
        instanceId,
        async (newChildren: string[]) => {
          await this._onChildrenChanged(instanceId, newChildren);
          this._watchLoop(instanceId);
        }
      );
      await this._onChildrenChanged(instanceId, children);
    } catch (err) {
      console.error(
        `[MessageWatcher] Watch failed for ${instanceId.slice(0, 8)}:`,
        err
      );
      this.stopWatching(instanceId);
    }
  }

  private async _onChildrenChanged(
    instanceId: string,
    children: string[]
  ): Promise<void> {
    const state = this.instances.get(instanceId);
    if (!state || state.stopped) return;

    for (const msgId of children) {
      if (state.inFlight.has(msgId)) continue;
      const data = await this.zk.getMessage(instanceId, msgId);
      if (!data) continue;
      const msg = MessageSchema.parse({ ...data, id: msgId });
      if (!msg.read) {
        state.inFlight.add(msgId);
        state.queue.push(msg);
      }
    }

    if (!state.processing && state.queue.length > 0) {
      this._processQueue(instanceId);
    }
  }

  private async _processQueue(instanceId: string): Promise<void> {
    const state = this.instances.get(instanceId);
    if (!state || state.stopped) return;

    state.processing = true;

    while (state.queue.length > 0 && !state.stopped) {
      const msg = state.queue.shift()!;
      const fromLabel =
        msg.from_name || msg.from_instance?.slice(0, 8) || "unknown";
      const prompt = `[${msg.type} from ${fromLabel}] ${msg.content}`;

      console.log(
        `[MessageWatcher] Processing message ${msg.id} for ${instanceId.slice(0, 8)}`
      );

      try {
        const child = spawn(
          "claude",
          ["--session-id", instanceId, "-p", prompt],
          {
            cwd: state.workDir,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env },
          }
        );
        state.child = child;

        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d) => (stdout += d.toString()));
        child.stderr?.on("data", (d) => (stderr += d.toString()));

        const { code, error } = await new Promise<{
          code: number;
          error: Error | null;
        }>((resolve) => {
          child.on("exit", (code) =>
            resolve({ code: code ?? -1, error: null })
          );
          child.on("error", (err) => resolve({ code: -1, error: err }));
        });

        state.child = null;

        if (error) {
          console.error(
            `[MessageWatcher] claude failed for ${instanceId.slice(0, 8)}: ${error.message}`
          );
        } else if (code !== 0) {
          console.error(
            `[MessageWatcher] claude exited ${code} for ${instanceId.slice(0, 8)}: ${stderr.slice(0, 200)}`
          );
        } else {
          console.log(
            `[MessageWatcher] Message ${msg.id} processed for ${instanceId.slice(0, 8)}`
          );
        }

        if (stdout) {
          console.log(
            `[MessageWatcher] Output: ${stdout.slice(0, 500)}`
          );
        }
      } catch (err) {
        console.error(
          `[MessageWatcher] Unexpected error processing ${msg.id}:`,
          err
        );
      }

      // Always mark as read
      try {
        msg.read = true;
        await this.zk.updateMessage(
          instanceId,
          msg.id,
          msg as unknown as Record<string, unknown>
        );
      } catch (err) {
        console.error(
          `[MessageWatcher] Failed to mark ${msg.id} as read:`,
          err
        );
      }

      state.inFlight.delete(msg.id);
    }

    state.processing = false;
  }
}
