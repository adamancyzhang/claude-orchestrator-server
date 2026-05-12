import { LeaderState, type WorkerInfo } from "./state.js";

const ESC = "\x1b";
const CLEAR = `${ESC}[2J${ESC}[0;0H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const BLUE = `${ESC}[34m`;
const MAGENTA = `${ESC}[35m`;
const CYAN = `${ESC}[36m`;

function padRight(s: string, n: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  return s + " ".repeat(Math.max(0, n - visible.length));
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function box(width: number, ...lines: string[]): string {
  const top = `${DIM}┌${"─".repeat(width - 2)}┐${RESET}\n`;
  const bottom = `${DIM}└${"─".repeat(width - 2)}┘${RESET}`;
  let body = "";
  for (const line of lines) {
    body += `${DIM}│${RESET}${padRight(line, width - 2)}${DIM}│${RESET}\n`;
  }
  return top + body + bottom;
}

function workerStatusColor(status: string): string {
  if (status === "idle") return GREEN;
  if (status === "busy") return YELLOW;
  return DIM;
}

export class LeaderTui {
  private inputBuffer = "";
  private inputCallback: ((text: string) => void) | null = null;
  private rawMode = false;

  constructor() {
    this.setupInput();
  }

  onInput(cb: (text: string) => void): void {
    this.inputCallback = cb;
  }

  private enableRawMode(): void {
    if (this.rawMode) return;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      this.rawMode = true;
    }
  }

  private disableRawMode(): void {
    if (!this.rawMode) return;
    process.stdin.setRawMode(false);
    process.stdin.pause();
    this.rawMode = false;
  }

  private setupInput(): void {
    process.stdin.on("data", (data: Buffer) => {
      const key = data.toString();

      if (key === "\x03") {
        // Ctrl+C — let SIGINT handler deal with it
        process.kill(process.pid, "SIGINT");
        return;
      }

      if (key === "\r" || key === "\n") {
        if (this.inputBuffer.trim() && this.inputCallback) {
          this.inputCallback(this.inputBuffer.trim());
        }
        this.inputBuffer = "";
        return;
      }

      if (key === "\x7f" || key === "\x08") {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
        return;
      }

      if (key === "\x1b") {
        this.inputBuffer = "";
        return;
      }

      // Printable characters only
      if (key >= " ") {
        this.inputBuffer += key;
      }
    });
  }

  render(state: LeaderState): void {
    this.enableRawMode();

    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 30;
    const halfW = Math.floor((cols - 4) / 2);

    let out = CLEAR + HIDE_CURSOR;

    // ── Team Panel (top) ──
    const teamWidth = cols - 2;
    const teamLines: string[] = [];
    teamLines.push(` ${BOLD}TEAM${RESET}`);
    teamLines.push(` ${DIM}${"─".repeat(teamWidth - 4)}${RESET}`);
    if (state.workers.length === 0) {
      teamLines.push(` ${DIM}No workers online${RESET}`);
    } else {
      const header = `${BOLD}${padRight("Name", 14)}${padRight("Preset", 12)}${padRight("Current Role", 16)}${padRight("Status", 8)}Current Task${RESET}`;
      teamLines.push(` ${header}`);
      for (const w of state.workers.slice(0, 8)) {
        const statusColored = `${workerStatusColor(w.status)}${padRight(w.status, 7)}${RESET}`;
        const currentRole = w.currentRole ?? `${DIM}(idle)${RESET}`;
        const cross = w.currentRole && w.currentRole !== w.presetRole ? `${MAGENTA}◀←${RESET} ` : "";
        const line = ` ${padRight(truncate(w.name, 13), 14)}${padRight(w.presetRole, 12)}${cross}${padRight(currentRole, 16)}${statusColored}${truncate(w.currentTaskId ?? "-", teamWidth - 54)}`;
        teamLines.push(line);
      }
      if (state.workers.length > 8) {
        teamLines.push(` ${DIM}... and ${state.workers.length - 8} more${RESET}`);
      }
    }
    const teamBoxH = teamLines.length + 2;
    out += box(teamWidth, ...teamLines);

    // ── Task Panels (middle, side by side) ──
    // Left: Pending
    const pendLines: string[] = [];
    pendLines.push(` ${BOLD}PENDING${RESET}`);
    pendLines.push(` ${DIM}${"─".repeat(halfW - 4)}${RESET}`);
    const pendTasks = state.pendingTasks.slice(0, 10);
    if (pendTasks.length === 0) {
      pendLines.push(` ${DIM}No pending tasks${RESET}`);
    } else {
      for (const t of pendTasks) {
        const title = truncate(t.title as string ?? "", halfW - 16);
        const prio = (t.priority as number) === 0 ? `${RED}HIGH${RESET}` :
                     (t.priority as number) === 1 ? `${YELLOW}MED${RESET}` : `${DIM}LOW${RESET}`;
        const link = t.link ? `${CYAN}[${(t.link as string).charAt(0).toUpperCase() + (t.link as string).slice(1)}]${RESET} ` : "";
        pendLines.push(` ${link}${prio} ${title}`);
      }
    }

    // Right: In Progress
    const progLines: string[] = [];
    progLines.push(` ${BOLD}IN PROGRESS${RESET}`);
    progLines.push(` ${DIM}${"─".repeat(halfW - 4)}${RESET}`);
    const progTasks = state.claimedTasks.slice(0, 10);
    if (progTasks.length === 0) {
      progLines.push(` ${DIM}No tasks in progress${RESET}`);
    } else {
      for (const t of progTasks) {
        const title = truncate(t.title as string ?? "", halfW - 10);
        const who = truncate((t.claimed_by as string)?.slice(0, 8) ?? "?", 8);
        progLines.push(` ${BLUE}${who}${RESET} ${title}`);
      }
    }

    // Pad both to same height
    const taskH = Math.max(pendLines.length, progLines.length) + 2;
    while (pendLines.length < taskH - 2) pendLines.push("");
    while (progLines.length < taskH - 2) progLines.push("");

    const leftBox = box(halfW, ...pendLines).split("\n");
    const rightBox = box(halfW, ...progLines).split("\n");
    for (let i = 0; i < leftBox.length; i++) {
      out += leftBox[i] + " " + rightBox[i] + "\n";
    }

    // ── Event Log ──
    const inputSectionH = 4; // input box height
    const remainingH = rows - teamBoxH - (taskH + 2) - 3 - inputSectionH;
    const logH = Math.max(remainingH, 3);
    const logLines: string[] = [];
    logLines.push(` ${BOLD}EVENT LOG${RESET}`);
    logLines.push(` ${DIM}${"─".repeat(cols - 4)}${RESET}`);
    const events = state.events.slice(-(logH - 3));
    for (const e of events) {
      logLines.push(` ${DIM}${e.timestamp}${RESET} ${e.message}`);
    }
    while (logLines.length < logH - 1) logLines.push("");
    out += box(cols - 2, ...logLines);

    // ── Input Line ──
    const inputPrompt = `> ${this.inputBuffer}█`;
    const inputHint = this.inputBuffer.length === 0 ? `${DIM}Type a message and press Enter to send${RESET}` : "";
    const inputBox = box(cols - 2, inputPrompt, inputHint || " ");
    out += inputBox;

    // ── Footer ──
    const idShort = state.leaderInstanceId.slice(0, 8);
    const footer = `${DIM}Leader: ${state.leaderName} | Instance: ${idShort} | CACHE_DIR: ${state.cacheDir} | Ctrl+C to stop${RESET}`;
    out += `\n${footer}`;

    process.stdout.write(out);
  }

  destroy(): void {
    this.disableRawMode();
    process.stdout.write(SHOW_CURSOR + CLEAR);
  }
}
