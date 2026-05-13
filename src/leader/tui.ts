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

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function padRight(s: string, n: number): string {
  const visible = stripAnsi(s).length;
  return s + " ".repeat(Math.max(0, n - visible));
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function wrapText(s: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const ch of s) {
    if (ch === "\n") {
      lines.push(current);
      current = "";
    } else if (current.length >= maxWidth) {
      lines.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);
  return lines;
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

function renderWorkerMessages(
  worker: WorkerInfo,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  const contentW = maxWidth - 4;

  if (worker.currentMessage) {
    const linkTag = worker.currentMessageLink
      ? ` ${CYAN}[${worker.currentMessageLink}]${RESET}`
      : "";
    const time = worker.currentMessageTime
      ? ` ${DIM}(${worker.currentMessageTime})${RESET}`
      : "";
    lines.push(` ${GREEN}◆${RESET} ${BOLD}Working${RESET}${time}${linkTag}`);

    const wrapped = wrapText(worker.currentMessage, contentW - 2);
    for (const line of wrapped) {
      lines.push(`   ${line}`);
    }
    lines.push("");
  } else if (worker.status === "busy" && worker.currentTaskId) {
    const roleTag = worker.currentRole
      ? ` ${MAGENTA}[${worker.currentRole}]${RESET}`
      : "";
    lines.push(` ${YELLOW}◆${RESET} ${BOLD}Working${RESET}${roleTag}`);
    lines.push(`   ${DIM}Task: ${worker.currentTaskId}${RESET}`);
    lines.push("");
  } else if (worker.lastCompletedTask) {
    lines.push(` ${DIM}◇ (idle) — last: ${worker.lastCompletedTask}${RESET}`);
    lines.push("");
  } else {
    lines.push(` ${DIM}◇ (idle)${RESET}`);
    lines.push("");
  }

  if (worker.messageHistory.length > 0) {
    lines.push(` ${BOLD}History:${RESET}`);
    for (const entry of worker.messageHistory.slice(-5).reverse()) {
      const time = `${DIM}${entry.timestamp}${RESET}`;
      const link = entry.link ? ` ${CYAN}[${entry.link}]${RESET}` : "";
      lines.push(`   ${time}${link}`);
      const wrapped = wrapText(entry.content, contentW - 4);
      for (const line of wrapped) {
        lines.push(`     ${DIM}${line}${RESET}`);
      }
    }
  }

  return lines;
}

export class LeaderTui {
  private inputBuffer = "";
  private inputCallback: ((text: string) => void) | null = null;
  private rawMode = false;
  private state: LeaderState | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.setupInput();
    this.setupResizeHandler();
    this.startRefreshTimer();
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

  private rerender(): void {
    if (this.state) this.render(this.state);
  }

  private setupResizeHandler(): void {
    process.stdout.on("resize", () => {
      this.rerender();
    });
  }

  private startRefreshTimer(): void {
    this.refreshTimer = setInterval(() => {
      this.rerender();
    }, 1000);
  }

  private setupInput(): void {
    process.stdin.on("data", (data: Buffer) => {
      const key = data.toString();

      if (key === "\x03") {
        process.kill(process.pid, "SIGINT");
        return;
      }

      if (key === "\t") {
        if (this.state && this.state.workers.length > 0) {
          this.state.selectedWorkerIndex =
            (this.state.selectedWorkerIndex + 1) % this.state.workers.length;
          this.rerender();
        }
        return;
      }

      if (key === "\x1b[Z") {
        if (this.state && this.state.workers.length > 0) {
          this.state.selectedWorkerIndex =
            (this.state.selectedWorkerIndex - 1 + this.state.workers.length) %
            this.state.workers.length;
          this.rerender();
        }
        return;
      }

      if (key >= "1" && key <= "9") {
        const idx = parseInt(key) - 1;
        if (this.state && idx < this.state.workers.length) {
          this.state.selectedWorkerIndex = idx;
          this.rerender();
        }
        return;
      }

      if (key === "\r" || key === "\n") {
        if (this.inputBuffer.trim() && this.inputCallback) {
          this.inputCallback(this.inputBuffer.trim());
        }
        this.inputBuffer = "";
        this.rerender();
        return;
      }

      if (key === "\x7f" || key === "\x08") {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
        this.rerender();
        return;
      }

      if (key === "\x1b") {
        this.inputBuffer = "";
        this.rerender();
        return;
      }

      if (key >= " ") {
        this.inputBuffer += key;
        this.rerender();
      }
    });
  }

  render(state: LeaderState): void {
    this.state = state;
    this.enableRawMode();

    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 30;
    const halfW = Math.floor((cols - 4) / 2);

    let out = CLEAR + HIDE_CURSOR;

    // ── Team Panel (top) ──
    const teamWidth = cols - 2;
    const teamLines: string[] = [];

    // Responsive column widths
    const availW = teamWidth - 4;
    const nameW = Math.max(6, Math.floor(availW * 0.13));
    const roleW = Math.max(6, Math.floor(availW * 0.12));
    const wtW = Math.max(8, Math.floor(availW * 0.15));
    const branchW = Math.max(8, Math.floor(availW * 0.20));
    const pidW = 6;
    const statusW = 8;

    teamLines.push(` ${BOLD}TEAM${RESET}`);
    teamLines.push(` ${DIM}${"─".repeat(teamWidth - 4)}${RESET}`);
    if (state.workers.length === 0) {
      teamLines.push(` ${DIM}No workers online${RESET}`);
    } else {
      const header = `${BOLD}${padRight("Name", nameW)}${padRight("Role", roleW)}${padRight("Worktree", wtW)}${padRight("Branch", branchW)}${padRight("PID", pidW)}${padRight("Status", statusW)}${RESET}`;
      teamLines.push(` ${header}`);
      const maxWorkers = Math.min(state.workers.length, 8);
      for (let i = 0; i < maxWorkers; i++) {
        const w = state.workers[i];
        const selected = i === state.selectedWorkerIndex;
        const marker = selected ? `${BOLD}${CYAN}>${RESET}` : " ";
        const name = selected
          ? `${BOLD}${CYAN}${padRight(truncate(w.name, nameW - 1), nameW - 1)}${RESET}`
          : padRight(truncate(w.name, nameW - 1), nameW - 1);
        const role = w.currentRole
          ? `${MAGENTA}${padRight(w.currentRole, roleW - 2)}${RESET}${DIM}◀←${RESET}`
          : padRight(w.presetRole, roleW);
        const wt = padRight(truncate(w.worktreeName ?? w.name, wtW - 1), wtW - 1);
        const branch = padRight(truncate(w.worktreeBranch ?? "-", branchW - 1), branchW - 1);
        const pid = padRight(w.pid !== null ? String(w.pid) : "-", pidW - 1);
        const statusColored = `${workerStatusColor(w.status)}${padRight(w.status, statusW - 1)}${RESET}`;
        const line = ` ${marker} ${name} ${role} ${DIM}${wt}${RESET} ${DIM}${branch}${RESET} ${pid} ${statusColored}`;
        teamLines.push(line);
      }
      if (state.workers.length > 8) {
        teamLines.push(` ${DIM}... and ${state.workers.length - 8} more${RESET}`);
      }
    }
    const teamBoxH = teamLines.length + 2;
    out += box(teamWidth, ...teamLines);

    // ── Task Panels (middle, side by side) ──
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

    const taskH = Math.max(pendLines.length, progLines.length) + 2;
    while (pendLines.length < taskH - 2) pendLines.push("");
    while (progLines.length < taskH - 2) progLines.push("");

    const leftBox = box(halfW, ...pendLines).split("\n");
    const rightBox = box(halfW, ...progLines).split("\n");
    for (let i = 0; i < leftBox.length; i++) {
      out += leftBox[i] + " " + rightBox[i] + "\n";
    }

    // ── Worker Messages Panel ──
    const msgWidth = cols - 2;
    const msgLines: string[] = [];
    const selected = state.workers[state.selectedWorkerIndex];
    if (selected) {
      const title = `WORKER MESSAGES — ${selected.name} (${selected.presetRole})`;
      msgLines.push(` ${title}`);
      msgLines.push(` ${DIM}${"─".repeat(msgWidth - 4)}${RESET}`);

      const msgContent = renderWorkerMessages(selected, msgWidth);
      for (const line of msgContent.slice(0, 10)) {
        msgLines.push(line);
      }
      while (msgLines.length < 12) msgLines.push("");
    } else {
      msgLines.push(` ${DIM}No workers${RESET}`);
      while (msgLines.length < 12) msgLines.push("");
    }
    const msgH = msgLines.length + 2;
    out += box(msgWidth, ...msgLines);

    // ── Event Log ──
    const inputSectionH = 4;
    const remainingH = rows - teamBoxH - (taskH + 2) - msgH - inputSectionH - 3;
    const logH = Math.max(remainingH, 3);
    const logLines: string[] = [];
    logLines.push(` ${BOLD}EVENT LOG${RESET}`);
    logLines.push(` ${DIM}${"─".repeat(cols - 4)}${RESET}`);
    const events = state.events.slice(-(logH - 3));
    for (const e of events) {
      const msg = truncate(e.message, cols - 18);
      logLines.push(` ${DIM}${e.timestamp}${RESET} ${msg}`);
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
    const cacheDisplay = state.cacheDir.length > 60
      ? "..." + state.cacheDir.slice(-57)
      : state.cacheDir;
    const footer = `${DIM}Leader: ${state.leaderName} | Instance: ${idShort} | Cache: ${cacheDisplay} | Ctrl+C to stop${RESET}`;
    out += `\n${footer}`;

    process.stdout.write(out);
  }

  destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.disableRawMode();
    process.stdout.write(SHOW_CURSOR + CLEAR);
  }
}
