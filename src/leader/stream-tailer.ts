import * as fs from "node:fs";

export class StreamTailer {
  private activeFile: string | null = null;
  private lastPosition = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onLine: ((line: string) => void) | null = null;

  constructor(private pollIntervalMs = 200) {}

  start(filePath: string, onLine: (line: string) => void): void {
    this.stop();
    this.activeFile = filePath;
    this.lastPosition = 0;
    this.onLine = onLine;
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
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

  private poll(): void {
    if (!this.activeFile || !this.onLine) return;
    try {
      const stat = fs.statSync(this.activeFile);
      if (stat.size <= this.lastPosition) {
        if (stat.size < this.lastPosition) {
          this.lastPosition = 0;
        }
        return;
      }
      const fd = fs.openSync(this.activeFile, "r");
      const buf = Buffer.alloc(stat.size - this.lastPosition);
      fs.readSync(fd, buf, 0, buf.length, this.lastPosition);
      fs.closeSync(fd);
      this.lastPosition = stat.size;

      const content = buf.toString("utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (line.length > 0) this.onLine(line);
      }
    } catch {
      // file not created yet — retry on next poll
    }
  }
}
