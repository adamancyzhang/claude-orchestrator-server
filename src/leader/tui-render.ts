import type { WorkerInfo, EventLogEntry } from "./state.js";
import type { Task } from "../models/schemas.js";

// ── ANSI codes ──

const ESC = "\x1b";
export const CLEAR = `${ESC}[2J${ESC}[0;0H`;
export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;
export const RESET = `${ESC}[0m`;
export const BOLD = `${ESC}[1m`;
export const DIM = `${ESC}[2m`;
export const RED = `${ESC}[31m`;
export const GREEN = `${ESC}[32m`;
export const YELLOW = `${ESC}[33m`;
export const BLUE = `${ESC}[34m`;
export const MAGENTA = `${ESC}[35m`;
export const CYAN = `${ESC}[36m`;

// Minimum terminal dimensions before we render the "too small" warning.
export const MIN_COLS = 80;
export const MIN_ROWS = 20;

export interface TuiUiState {
  pendingInput: string | null;
  sentAt: number | null;
  streamPaused: boolean;
  streamScrollOffset: number;
  eventFilter: "all" | "task" | "worker" | "chain";
  showHelp: boolean;
  inputBuffer: string;
  nowMs?: number;
}

export function defaultUiState(): TuiUiState {
  return {
    pendingInput: null,
    sentAt: null,
    streamPaused: false,
    streamScrollOffset: 0,
    eventFilter: "all",
    showHelp: false,
    inputBuffer: "",
  };
}

// ── Pure helpers ──

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function padRight(s: string, n: number): string {
  const visible = stripAnsi(s).length;
  return s + " ".repeat(Math.max(0, n - visible));
}

export function truncate(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

export function wrapText(s: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [];
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

export function box(width: number, ...lines: string[]): string {
  if (width < 2) return lines.join("\n");
  const top = `${DIM}┌${"─".repeat(width - 2)}┐${RESET}\n`;
  const bottom = `${DIM}└${"─".repeat(width - 2)}┘${RESET}`;
  let body = "";
  for (const line of lines) {
    body += `${DIM}│${RESET}${padRight(line, width - 2)}${DIM}│${RESET}\n`;
  }
  return top + body + bottom;
}

const NON_TEXT_TYPES = new Set([
  "message_start", "message_delta", "message_stop",
  "content_block_stop", "ping", "system", "result", "assistant", "user",
]);

/**
 * Extract human-readable text from a Claude stream JSON event line.
 *
 * Unlike the prior implementation, never throws on unknown event types — TUI
 * stability must not depend on Claude's wire format. Unknown event types
 * return "" so the caller skips rendering that line, and malformed JSON
 * also returns "" rather than crashing the TUI.
 */
export function stripJsonChunk(line: string): string {
  let parsed: { type?: string; delta?: { text?: string }; content_block?: { text?: string } };
  try {
    parsed = JSON.parse(line);
  } catch {
    return "";
  }
  if (parsed.type === "content_block_delta" && parsed.delta?.text) {
    return parsed.delta.text;
  }
  if (parsed.type === "content_block_start" && parsed.content_block?.text) {
    return parsed.content_block.text;
  }
  if (parsed.type && NON_TEXT_TYPES.has(parsed.type)) {
    return "";
  }
  // Unknown — be permissive, drop silently.
  return "";
}

export function workerStatusColor(status: string): string {
  if (status === "idle") return GREEN;
  if (status === "busy") return YELLOW;
  return DIM;
}

// ── Section renderers (each returns line array; caller composes layout) ──

export function renderTeamGrid(
  workers: WorkerInfo[],
  selectedIndex: number,
  width: number,
): string[] {
  const lines: string[] = [];
  const availW = Math.max(20, width - 4);
  const nameW = Math.max(6, Math.floor(availW * 0.13));
  const roleW = Math.max(6, Math.floor(availW * 0.12));
  const wtW = Math.max(8, Math.floor(availW * 0.15));
  const branchW = Math.max(8, Math.floor(availW * 0.20));
  const pidW = 6;
  const statusW = 8;

  lines.push(` ${BOLD}TEAM${RESET}`);
  lines.push(` ${DIM}${"─".repeat(Math.max(1, width - 4))}${RESET}`);
  if (workers.length === 0) {
    lines.push(` ${DIM}No workers online${RESET}`);
    return lines;
  }
  const header =
    `${BOLD}${padRight("Name", nameW)}${padRight("Role", roleW)}${padRight("Worktree", wtW)}` +
    `${padRight("Branch", branchW)}${padRight("PID", pidW)}${padRight("Status", statusW)}${RESET}`;
  lines.push(` ${header}`);

  const maxWorkers = Math.min(workers.length, 8);
  for (let i = 0; i < maxWorkers; i++) {
    const w = workers[i];
    const selected = i === selectedIndex;
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
    lines.push(` ${marker} ${name} ${role} ${DIM}${wt}${RESET} ${DIM}${branch}${RESET} ${pid} ${statusColored}`);
  }
  if (workers.length > 8) {
    lines.push(` ${DIM}... and ${workers.length - 8} more${RESET}`);
  }
  return lines;
}

export function renderPendingTasks(pending: Task[], width: number): string[] {
  const lines: string[] = [];
  lines.push(` ${BOLD}PENDING${RESET}`);
  lines.push(` ${DIM}${"─".repeat(Math.max(1, width - 4))}${RESET}`);
  const tasks = pending.slice(0, 10);
  if (tasks.length === 0) {
    lines.push(` ${DIM}No pending tasks${RESET}`);
    return lines;
  }
  for (const t of tasks) {
    const title = truncate(t.title ?? "", Math.max(4, width - 16));
    const prio = t.priority === 0 ? `${RED}HIGH${RESET}` :
                 t.priority === 1 ? `${YELLOW}MED${RESET}` : `${DIM}LOW${RESET}`;
    const link = t.link ? `${CYAN}[${t.link.charAt(0).toUpperCase() + t.link.slice(1)}]${RESET} ` : "";
    lines.push(` ${link}${prio} ${title}`);
  }
  return lines;
}

export function renderClaimedTasks(claimed: Task[], width: number): string[] {
  const lines: string[] = [];
  lines.push(` ${BOLD}IN PROGRESS${RESET}`);
  lines.push(` ${DIM}${"─".repeat(Math.max(1, width - 4))}${RESET}`);
  const tasks = claimed.slice(0, 10);
  if (tasks.length === 0) {
    lines.push(` ${DIM}No tasks in progress${RESET}`);
    return lines;
  }
  for (const t of tasks) {
    const title = truncate(t.title ?? "", Math.max(4, width - 10));
    const who = truncate(t.claimed_by?.slice(0, 8) ?? "?", 8);
    lines.push(` ${BLUE}${who}${RESET} ${title}`);
  }
  return lines;
}

/**
 * Sender role badge. Leader messages get [L] blue; worker messages get
 * [W:<role>] cyan. The badge lets users scan history at a glance instead
 * of squinting at sender names.
 */
export function senderBadge(role: string | null | undefined): string {
  const r = (role ?? "").toLowerCase();
  if (r === "leader") return `${BLUE}[L]${RESET}`;
  if (r) return `${CYAN}[W:${r}]${RESET}`;
  return `${DIM}[?]${RESET}`;
}

export function renderWorkerMessages(
  worker: WorkerInfo,
  maxWidth: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  const contentW = Math.max(10, maxWidth - 4);

  if (worker.currentMessage) {
    const linkTag = worker.currentMessageLink
      ? ` ${CYAN}[${worker.currentMessageLink}]${RESET}` : "";
    const time = worker.currentMessageTime
      ? ` ${DIM}(${worker.currentMessageTime})${RESET}` : "";
    lines.push(` ${GREEN}◆${RESET} ${BOLD}Working${RESET}${time}${linkTag}`);

    const wrapped = wrapText(worker.currentMessage, contentW - 2);
    for (const line of wrapped) lines.push(`   ${line}`);
    lines.push("");
  } else if (worker.status === "busy" && worker.currentTaskId) {
    const roleTag = worker.currentRole ? ` ${MAGENTA}[${worker.currentRole}]${RESET}` : "";
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
      for (const line of wrapped) lines.push(`     ${DIM}${line}${RESET}`);
    }
  }

  // Multiline overflow marker: don't silently drop content.
  if (lines.length > maxLines) {
    const overflow = lines.length - (maxLines - 1);
    const visible = lines.slice(0, maxLines - 1);
    visible.push(` ${DIM}… (${overflow} more lines — press Enter on worker name to expand)${RESET}`);
    return visible;
  }
  return lines;
}

export function renderStreamPanel(
  worker: WorkerInfo,
  width: number,
  height: number,
  ui: { streamPaused: boolean; streamScrollOffset: number },
): string[] {
  const lines: string[] = [];
  const contentW = Math.max(10, width - 4);

  const titlePrefix = worker.streamActive ? "LIVE STREAM" : "LAST OUTPUT";
  const pauseLabel = ui.streamPaused ? ` ${YELLOW}(PAUSED — Ctrl+P to resume)${RESET}` : "";
  lines.push(` ${BOLD}${titlePrefix}${RESET} — ${worker.name} (${worker.presetRole})${pauseLabel}`);
  lines.push(` ${DIM}${"─".repeat(Math.max(1, width - 4))}${RESET}`);

  if (worker.streamActive && !ui.streamPaused) {
    lines.push(` ${GREEN}${BOLD}═══ Streaming... ═══${RESET}`);
  }

  // Compute slice from streamBuffer with optional scroll offset.
  const tailCount = Math.max(5, height - 4);
  const buf = worker.streamBuffer;
  const end = Math.max(0, buf.length - ui.streamScrollOffset);
  const start = Math.max(0, end - tailCount);
  const slice = buf.slice(start, end);

  for (const raw of slice) {
    const plain = stripJsonChunk(raw);
    if (!plain) continue;
    const wrapped = wrapText(plain, contentW);
    for (const w of wrapped) {
      const colour = worker.streamActive ? CYAN : DIM;
      lines.push(` ${colour}${w}${RESET}`);
    }
  }
  if (ui.streamScrollOffset > 0) {
    lines.push(` ${DIM}↑ scrolled ${ui.streamScrollOffset} (↑/↓ to scroll, End to follow)${RESET}`);
  }
  return lines;
}

export function renderEventLog(
  events: EventLogEntry[],
  height: number,
  width: number,
  filter: TuiUiState["eventFilter"],
): string[] {
  const lines: string[] = [];
  const filterLabel = filter === "all" ? "" : ` ${CYAN}[filter: ${filter}]${RESET}`;
  lines.push(` ${BOLD}EVENT LOG${RESET}${filterLabel}`);
  lines.push(` ${DIM}${"─".repeat(Math.max(1, width - 4))}${RESET}`);
  const filtered = events.filter((e) => {
    if (filter === "all") return true;
    const msg = e.message.toLowerCase();
    if (filter === "task") return msg.includes("task");
    if (filter === "worker") return msg.includes("joined") || msg.includes("left") || msg.includes("received");
    if (filter === "chain") return msg.includes("chain");
    return true;
  });
  const slice = filtered.slice(-(Math.max(1, height - 3)));
  for (const e of slice) {
    const msg = truncate(e.message, Math.max(20, width - 18));
    lines.push(` ${DIM}${e.timestamp}${RESET} ${msg}`);
  }
  return lines;
}

export interface InputLineStatus {
  pendingInput: string | null;
  sentAt: number | null;
  nowMs: number;
}

/** Display "✓ sent" or "… sending" indicator briefly after Enter. */
export function renderInputLine(buffer: string, status: InputLineStatus): { line: string; hint: string } {
  const prompt = `> ${buffer}█`;
  if (status.pendingInput !== null && status.sentAt !== null) {
    const elapsed = status.nowMs - status.sentAt;
    if (elapsed < 300) {
      // Still in flight — show yellow spinner
      return { line: prompt, hint: `${YELLOW}… sending: ${truncate(status.pendingInput, 60)}${RESET}` };
    }
    if (elapsed < 2000) {
      return { line: prompt, hint: `${GREEN}✓ sent: ${truncate(status.pendingInput, 60)}${RESET}` };
    }
  }
  if (buffer.length === 0) {
    return { line: prompt, hint: `${DIM}Type a message and press Enter to send${RESET}` };
  }
  return { line: prompt, hint: " " };
}

const FOOTER_HINTS = [
  "Tab=next worker | Shift+Tab=prev",
  "1-9=jump to worker | Esc=clear input",
  "Ctrl+P=pause stream | ↑/↓=scroll | End=follow",
  "f=filter events | ?=help | Ctrl+C=quit",
];

export function renderFooter(cols: number, leaderName: string, instanceId: string, cacheDir: string, nowMs: number): string {
  const idShort = instanceId.slice(0, 8);
  const cache = cacheDir.length > 40 ? "..." + cacheDir.slice(-37) : cacheDir;
  const hint = FOOTER_HINTS[Math.floor(nowMs / 4000) % FOOTER_HINTS.length];
  const base = ` ${DIM}Leader: ${leaderName} | Instance: ${idShort} | Cache: ${cache}${RESET}`;
  const tip = `  ${CYAN}${hint}${RESET}`;
  // If too narrow, only show tip
  if (cols < 100) return tip;
  return base + tip;
}

export function renderTerminalTooSmall(cols: number, rows: number): string[] {
  return [
    "",
    `  ${RED}${BOLD}Terminal too small${RESET}`,
    "",
    `  Current size: ${cols} × ${rows}`,
    `  Required:     ${MIN_COLS} × ${MIN_ROWS}`,
    "",
    `  ${DIM}Resize your terminal to continue.${RESET}`,
    "",
  ];
}

export function renderHelpOverlay(cols: number): string[] {
  const lines: string[] = [
    ` ${BOLD}KEYBINDINGS${RESET}`,
    ` ${DIM}${"─".repeat(Math.max(1, cols - 4))}${RESET}`,
    `   ${CYAN}Tab${RESET} / ${CYAN}Shift+Tab${RESET}  Cycle selected worker`,
    `   ${CYAN}1-9${RESET}              Jump to worker N`,
    `   ${CYAN}Enter${RESET}            Send typed message`,
    `   ${CYAN}Backspace${RESET}        Delete last char`,
    `   ${CYAN}Esc${RESET}              Clear input`,
    `   ${CYAN}Ctrl+P${RESET}           Pause / resume stream`,
    `   ${CYAN}↑ / ↓${RESET}            Scroll stream`,
    `   ${CYAN}End${RESET}              Follow latest stream`,
    `   ${CYAN}f${RESET}                Cycle event-log filter`,
    `   ${CYAN}?${RESET}                Toggle this help`,
    `   ${CYAN}Ctrl+L${RESET}           Redraw screen`,
    `   ${CYAN}Ctrl+C${RESET}           Quit`,
    "",
    ` ${DIM}Press ? again to dismiss${RESET}`,
  ];
  return lines;
}
