// ── Backward-compat stubs ───────────────────────────────────────────
// Ink handles stdin, stdout, and resize internally. These stubs exist
// solely so orchestrator/src/run.ts compiles without pulling in Ink.

export interface TuiSink {
  write(s: string): void;
  cols(): number;
  rows(): number;
  onResize?(cb: () => void): void;
}

export class StdoutSink implements TuiSink {
  write(_s: string): void { /* no-op: Ink writes to stdout */ }
  cols(): number { return process.stdout.columns || 120; }
  rows(): number { return process.stdout.rows || 30; }
  onResize(_cb: () => void): void { /* no-op: Ink's useWindowSize handles resize */ }
}

export class StdinKeyboardSource {
  start(): void { /* no-op: Ink's useInput handles raw mode */ }
  stop(): void { /* no-op */ }
  onInput(_cb: (input: unknown) => void): void { /* no-op */ }
}
