import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import type { IMessageRouter, InstanceId, SendMessageInput } from "@co/contracts";

export interface CommandWatcherOptions {
  stateDir: string;
  messageRouter: IMessageRouter;
  leaderId: InstanceId;
  leaderName: string;
}

interface ParsedCommand {
  type: string;
  content?: string;
  timestamp?: string;
}

export class CommandWatcher {
  private watcher: FSWatcher | null = null;
  private readonly filePath: string;
  private readonly dirPath: string;
  private readonly messageRouter: IMessageRouter;
  private readonly leaderId: InstanceId;
  private readonly leaderName: string;
  private byteOffset = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;

  constructor(opts: CommandWatcherOptions) {
    this.dirPath = opts.stateDir;
    this.filePath = `${opts.stateDir}/commands.jsonl`;
    this.messageRouter = opts.messageRouter;
    this.leaderId = opts.leaderId;
    this.leaderName = opts.leaderName;
  }

  async start(): Promise<void> {
    // Read existing file size so we only process new lines going forward.
    try {
      const stat = statSync(this.filePath);
      this.byteOffset = stat.size;
    } catch {
      // File does not exist yet; start at offset 0.
      this.byteOffset = 0;
    }

    // Watch the directory (not the file) so we get events even when the
    // file is created after start().
    this.watcher = watch(this.dirPath, () => {
      this.scheduleProcess();
    });
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  private scheduleProcess(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.processNewLines();
    }, 100);
  }

  private async processNewLines(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      let fd: string;
      try {
        fd = readFileSync(this.filePath, "utf-8");
      } catch {
        // File does not exist yet; nothing to process.
        return;
      }
      const bytes = Buffer.byteLength(fd, "utf-8");

      if (bytes <= this.byteOffset) {
        // No new data.
        return;
      }

      const newData = fd.slice(this.byteOffset);
      this.byteOffset = bytes;

      const lines = newData.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        await this.processLine(trimmed);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processLine(line: string): Promise<void> {
    let parsed: ParsedCommand;
    try {
      parsed = JSON.parse(line) as ParsedCommand;
    } catch {
      // Malformed JSON line; skip.
      return;
    }

    if (parsed.type === "send" && typeof parsed.content === "string") {
      const input: SendMessageInput = {
        type: "direct",
        from_instance: this.leaderId,
        from_name: this.leaderName,
        to_instance: null,
        content: parsed.content,
      };

      try {
        await this.messageRouter.send(input);
      } catch {
        // messageRouter.send failure propagates to caller.
      }
    }
  }
}
