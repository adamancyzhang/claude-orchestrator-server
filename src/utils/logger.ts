export class Logger {
  private static debugEnabled = false;

  static enableDebug(): void { Logger.debugEnabled = true; }
  static isDebug(): boolean { return Logger.debugEnabled; }

  constructor(private tag: string) {}

  info(msg: string): void {
    console.log(`[${this.tag}] ${msg}`);
  }

  error(msg: string, err?: unknown): void {
    const extra = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${err}` : "";
    console.error(`[${this.tag}] ${msg}${extra}`);
  }

  debug(msg: string): void {
    if (Logger.debugEnabled) {
      console.log(`[${this.tag}] [DEBUG] ${msg}`);
    }
  }
}
