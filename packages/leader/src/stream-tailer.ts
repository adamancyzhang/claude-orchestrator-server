import * as fs from "node:fs";

export type StreamLineCallback = (line: string) => void;

export class StreamTailer {
  private activeFile: string | null = null;
  private lastPosition = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onLine: StreamLineCallback | null = null;
  private polling = false;

  constructor(private readonly pollIntervalMs = 200) {}

  start(filePath: string, onLine: StreamLineCallback): void {
    this.stop();
    this.activeFile = filePath;
    this.lastPosition = 0;
    this.onLine = onLine;
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.activeFile = null;
    this.lastPosition = 0;
    this.onLine = null;
  }

  get isActive(): boolean {
    return this.pollTimer !== null;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    if (!this.activeFile || !this.onLine) return;

    this.polling = true;
    try {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(this.activeFile);
      } catch {
        return;
      }

      if (stat.size < this.lastPosition) {
        // File was truncated — reset position and read from the beginning.
        this.lastPosition = 0;
      }

      if (stat.size <= this.lastPosition) {
        return;
      }

      const buf = Buffer.alloc(stat.size - this.lastPosition);
      const fd = await fs.promises.open(this.activeFile, "r");
      try {
        await fd.read(buf, 0, buf.length, this.lastPosition);
      } finally {
        await fd.close();
      }
      this.lastPosition = stat.size;

      for (const line of buf.toString("utf-8").split("\n")) {
        if (line.length > 0) this.onLine(line);
      }
    } finally {
      this.polling = false;
    }
  }
}
