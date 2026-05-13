import { EventEmitter } from "node:events";

export class FakeStdin extends EventEmitter {
  isTTY = true;
  rawMode = false;
  paused = true;

  setRawMode(value: boolean): this {
    this.rawMode = value;
    return this;
  }
  resume(): this { this.paused = false; return this; }
  pause(): this { this.paused = true; return this; }

  pressKey(key: string | Buffer): void {
    const data = typeof key === "string" ? Buffer.from(key) : key;
    this.emit("data", data);
  }
}

export class CaptureStdout extends EventEmitter {
  columns = 120;
  rows = 30;
  writes: string[] = [];

  write(chunk: string | Buffer): boolean {
    this.writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }

  setSize(cols: number, rows: number): void {
    this.columns = cols;
    this.rows = rows;
    this.emit("resize");
  }

  get lastWrite(): string {
    return this.writes[this.writes.length - 1] ?? "";
  }

  get allWrites(): string {
    return this.writes.join("");
  }

  reset(): void {
    this.writes = [];
  }
}

/**
 * Install fake stdin/stdout for a test scope. Returns a cleanup function.
 */
export function installFakeStdio(): {
  stdin: FakeStdin;
  stdout: CaptureStdout;
  restore: () => void;
} {
  const origStdin = process.stdin;
  const origStdoutWrite = process.stdout.write;
  const origStdoutCols = process.stdout.columns;
  const origStdoutRows = process.stdout.rows;

  const stdin = new FakeStdin();
  const stdout = new CaptureStdout();

  Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
  // We patch process.stdout.write and dimensions but keep real stdout otherwise
  process.stdout.write = ((chunk: unknown) => {
    stdout.write(chunk as string);
    return true;
  }) as typeof process.stdout.write;
  Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => stdout.columns });
  Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => stdout.rows });

  const resizeForward = () => process.stdout.emit("resize");
  stdout.on("resize", resizeForward);

  return {
    stdin,
    stdout,
    restore: () => {
      stdout.off("resize", resizeForward);
      Object.defineProperty(process, "stdin", { configurable: true, value: origStdin });
      process.stdout.write = origStdoutWrite;
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: origStdoutCols });
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: origStdoutRows });
    },
  };
}
