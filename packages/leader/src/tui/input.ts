export type TuiInput =
  | { type: "char"; value: string }
  | { type: "enter" }
  | { type: "tab" }
  | { type: "shift_tab" }
  | { type: "escape" }
  | { type: "backspace" }
  | { type: "digit"; value: number }
  | { type: "ctrl_c" }
  | { type: "redraw" }
  | { type: "help_toggle" };

export function parseKey(key: string): TuiInput | null {
  if (key === "\x03") return { type: "ctrl_c" };
  if (key === "\x0c") return { type: "redraw" };
  if (key === "?") return { type: "help_toggle" };
  if (key === "\t") return { type: "tab" };
  if (key === "\x1b[Z") return { type: "shift_tab" };
  if (key === "\r" || key === "\n") return { type: "enter" };
  if (key === "\x7f" || key === "\x08") return { type: "backspace" };
  if (key === "\x1b") return { type: "escape" };
  if (key >= "1" && key <= "9") {
    return { type: "digit", value: parseInt(key, 10) };
  }
  if (key >= " " && key.length < 16) {
    return { type: "char", value: key };
  }
  return null;
}

export interface KeyboardSource {
  start(): void;
  stop(): void;
  onInput(cb: (input: TuiInput) => void): void;
}

export class StdinKeyboardSource implements KeyboardSource {
  private cb: ((input: TuiInput) => void) | null = null;
  private rawMode = false;
  private handler: ((data: Buffer) => void) | null = null;

  start(): void {
    if (this.rawMode || !process.stdin.isTTY) return;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    this.handler = (data: Buffer) => {
      const key = data.toString();
      const input = parseKey(key);
      if (input && this.cb) this.cb(input);
    };
    process.stdin.on("data", this.handler);
    this.rawMode = true;
  }

  stop(): void {
    if (!this.rawMode) return;
    if (this.handler) {
      process.stdin.removeListener("data", this.handler);
      this.handler = null;
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    this.rawMode = false;
  }

  onInput(cb: (input: TuiInput) => void): void {
    this.cb = cb;
  }
}
