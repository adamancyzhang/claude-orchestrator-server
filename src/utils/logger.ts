export class Logger {
  constructor(private tag: string) {}

  info(msg: string): void {
    console.log(`[${this.tag}] ${msg}`);
  }

  error(msg: string, err?: unknown): void {
    const extra = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${err}` : "";
    console.error(`[${this.tag}] ${msg}${extra}`);
  }
}
