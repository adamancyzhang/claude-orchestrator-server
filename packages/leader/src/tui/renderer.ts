import type {
  ILeaderStateView,
  LeaderEvent,
  Task,
  WorkerInfo,
} from "@co/contracts";

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

export const MIN_COLS = 80;
export const MIN_ROWS = 20;

export interface TuiUiState {
  pending_input: string | null;
  sent_at: number | null;
  input_buffer: string;
  show_help: boolean;
}

export function defaultUiState(): TuiUiState {
  return {
    pending_input: null,
    sent_at: null,
    input_buffer: "",
    show_help: false,
  };
}

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

function statusColor(status: WorkerInfo["status"]): string {
  if (status === "idle") return GREEN;
  if (status === "busy") return YELLOW;
  return DIM;
}

export function renderTeam(
  workers: readonly WorkerInfo[],
  selectedIndex: number,
  width: number,
): string[] {
  const lines: string[] = [];
  const availW = Math.max(20, width - 4);
  const nameW = Math.max(6, Math.floor(availW * 0.16));
  const roleW = Math.max(6, Math.floor(availW * 0.14));
  const wtW = Math.max(8, Math.floor(availW * 0.18));
  const branchW = Math.max(8, Math.floor(availW * 0.22));
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
    const role = w.current_role
      ? `${MAGENTA}${padRight(w.current_role, roleW - 2)}${RESET}${DIM}◀${RESET}`
      : padRight(w.preset_role, roleW);
    const wt = padRight(truncate(w.worktree_name ?? w.name, wtW - 1), wtW - 1);
    const branch = padRight(truncate(w.worktree_branch ?? "-", branchW - 1), branchW - 1);
    const pid = padRight(w.pid !== null ? String(w.pid) : "-", pidW - 1);
    const status = `${statusColor(w.status)}${padRight(w.status, statusW - 1)}${RESET}`;
    lines.push(` ${marker} ${name} ${role} ${DIM}${wt}${RESET} ${DIM}${branch}${RESET} ${pid} ${status}`);
  }
  return lines;
}

export function renderPendingTasks(pending: readonly Task[], width: number): string[] {
  const lines: string[] = [];
  lines.push(` ${BOLD}PENDING${RESET}`);
  lines.push(` ${DIM}${"─".repeat(Math.max(1, width - 4))}${RESET}`);
  const slice = pending.slice(0, 10);
  if (slice.length === 0) {
    lines.push(` ${DIM}No pending tasks${RESET}`);
    return lines;
  }
  for (const t of slice) {
    const title = truncate(t.title, Math.max(4, width - 16));
    const prio =
      t.priority === 0 ? `${RED}HIGH${RESET}` :
      t.priority === 1 ? `${YELLOW}MED${RESET}` :
                         `${DIM}LOW${RESET}`;
    const link = t.link
      ? `${CYAN}[${t.link.charAt(0).toUpperCase() + t.link.slice(1)}]${RESET} `
      : "";
    lines.push(` ${link}${prio} ${title}`);
  }
  return lines;
}

export function renderInProgress(claimed: readonly Task[], width: number): string[] {
  const lines: string[] = [];
  lines.push(` ${BOLD}IN PROGRESS${RESET}`);
  lines.push(` ${DIM}${"─".repeat(Math.max(1, width - 4))}${RESET}`);
  const slice = claimed.slice(0, 10);
  if (slice.length === 0) {
    lines.push(` ${DIM}No tasks in progress${RESET}`);
    return lines;
  }
  for (const t of slice) {
    const title = truncate(t.title, Math.max(4, width - 10));
    const who = t.claimed_by ? truncate(t.claimed_by.slice(0, 8), 8) : "?";
    lines.push(` ${BLUE}${who}${RESET} ${title}`);
  }
  return lines;
}

export function renderWorkerMessages(
  worker: WorkerInfo,
  width: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  const contentW = Math.max(10, width - 4);

  if (worker.current_message) {
    const linkTag = worker.current_message_link
      ? ` ${CYAN}[${worker.current_message_link}]${RESET}`
      : "";
    const time = worker.current_message_time
      ? ` ${DIM}(${worker.current_message_time})${RESET}`
      : "";
    lines.push(` ${GREEN}◆${RESET} ${BOLD}Working${RESET}${time}${linkTag}`);
    for (const wrapped of wrapText(worker.current_message, contentW - 2)) {
      lines.push(`   ${wrapped}`);
    }
    lines.push("");
  } else if (worker.last_completed_task) {
    lines.push(` ${DIM}◇ idle — last: ${worker.last_completed_task}${RESET}`);
    lines.push("");
  } else {
    lines.push(` ${DIM}◇ idle${RESET}`);
    lines.push("");
  }

  if (worker.message_history.length > 0) {
    lines.push(` ${BOLD}History:${RESET}`);
    for (const entry of worker.message_history.slice(-5).reverse()) {
      const time = `${DIM}${entry.timestamp}${RESET}`;
      const link = entry.link ? ` ${CYAN}[${entry.link}]${RESET}` : "";
      lines.push(`   ${time}${link}`);
      for (const wrapped of wrapText(entry.content, contentW - 4)) {
        lines.push(`     ${DIM}${wrapped}${RESET}`);
      }
    }
  }
  return lines.slice(0, maxLines);
}

function eventToString(event: LeaderEvent): string {
  switch (event.type) {
    case "worker_joined":
      return `${event.instance.name} joined (${event.instance.role})`;
    case "worker_left":
      return `${event.name} left`;
    case "worker_status_changed":
      return `worker ${event.instance_id.slice(0, 8)}: ${event.status}`;
    case "worker_message_received":
      return `${event.instance_id.slice(0, 8)} msg: ${event.content.slice(0, 60)}`;
    case "task_created":
      return `task created: ${event.task.title}`;
    case "task_claimed":
      return `task ${event.task_id} claimed by ${event.instance_id.slice(0, 8)}`;
    case "task_completed":
      return `task ${event.task_id} completed`;
    case "task_blocked":
      return `task ${event.task_id} blocked: ${event.reason}`;
    case "task_failed":
      return `task ${event.task_id} failed: ${event.reason}`;
    case "task_recovered":
      return `task ${event.task_id} recovered (retry ${event.retry_count})`;
    case "task_dependency_resolved":
      return `task ${event.task_id} unblocked`;
    case "message_sent":
      return `message ${event.message_type} ${event.from.slice(0, 8)} -> ${event.to?.slice(0, 8) ?? "all"}`;
    case "message_received":
      return `message from ${event.from.slice(0, 8)}: ${event.content.slice(0, 60)}`;
    case "message_processed":
      return `message ${event.message_id} processed`;
    case "chain_activated":
      return `chain ${event.chain_id} activated`;
    case "chain_closed":
      return `chain ${event.chain_id} closed`;
    case "debug_info":
      return `[debug] ${event.message}`;
    case "stream_chunk":
      return "";
  }
}

export function renderEventLog(
  events: readonly LeaderEvent[],
  height: number,
  width: number,
): string[] {
  const lines: string[] = [];
  lines.push(` ${BOLD}EVENT LOG${RESET}`);
  lines.push(` ${DIM}${"─".repeat(Math.max(1, width - 4))}${RESET}`);
  const messages = events
    .map(eventToString)
    .filter((s) => s.length > 0);
  const slice = messages.slice(-(Math.max(1, height - 3)));
  for (const m of slice) {
    lines.push(` ${truncate(m, Math.max(20, width - 4))}`);
  }
  return lines;
}

export function renderInputLine(
  buffer: string,
  status: { pending_input: string | null; sent_at: number | null; now_ms: number },
): { line: string; hint: string } {
  const prompt = `> ${buffer}█`;
  if (status.pending_input !== null && status.sent_at !== null) {
    const elapsed = status.now_ms - status.sent_at;
    if (elapsed < 2000) {
      return {
        line: prompt,
        hint: `${GREEN}✓ sent: ${truncate(status.pending_input, 60)}${RESET}`,
      };
    }
  }
  if (buffer.length === 0) {
    return {
      line: prompt,
      hint: `${DIM}Type a message and press Enter to send${RESET}`,
    };
  }
  return { line: prompt, hint: " " };
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

export interface ComposeFrameInput {
  state: ILeaderStateView;
  ui: TuiUiState;
  cols: number;
  rows: number;
  now_ms: number;
  leader_name: string;
  leader_id: string;
  projects_root: string;
}

export function composeFrame(input: ComposeFrameInput): string {
  const { state, ui, cols, rows, now_ms, leader_name } = input;
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    return CLEAR + HIDE_CURSOR + renderTerminalTooSmall(cols, rows).join("\n");
  }
  let out = CLEAR + HIDE_CURSOR;
  const halfW = Math.floor((cols - 4) / 2);

  const teamLines = renderTeam(state.workers, state.selected_worker_index, cols - 2);
  out += box(cols - 2, ...teamLines);

  const pendLines = renderPendingTasks(state.pending_tasks, halfW);
  const progLines = renderInProgress(state.in_progress_tasks, halfW);
  const taskH = Math.max(pendLines.length, progLines.length) + 2;
  while (pendLines.length < taskH - 2) pendLines.push("");
  while (progLines.length < taskH - 2) progLines.push("");
  const leftBox = box(halfW, ...pendLines).split("\n");
  const rightBox = box(halfW, ...progLines).split("\n");
  for (let i = 0; i < leftBox.length; i++) {
    out += leftBox[i] + " " + rightBox[i] + "\n";
  }

  const selected = state.workers[state.selected_worker_index];
  const msgWidth = cols - 2;
  const msgLines = selected
    ? [
        ` ${BOLD}WORKER MESSAGES${RESET} — ${selected.name} (${selected.preset_role})`,
        ` ${DIM}${"─".repeat(Math.max(1, msgWidth - 4))}${RESET}`,
        ...renderWorkerMessages(selected, msgWidth, 10),
      ]
    : [` ${DIM}No workers${RESET}`];
  while (msgLines.length < 12) msgLines.push("");
  out += box(msgWidth, ...msgLines);

  const logH = Math.max(5, rows - teamLines.length - taskH - msgLines.length - 8);
  const logLines = renderEventLog(state.events, logH, cols - 2);
  while (logLines.length < logH - 1) logLines.push("");
  out += box(cols - 2, ...logLines);

  const { line, hint } = renderInputLine(ui.input_buffer, {
    pending_input: ui.pending_input,
    sent_at: ui.sent_at,
    now_ms,
  });
  out += box(cols - 2, line, hint);

  out += `\n${DIM}Leader: ${leader_name} | Tab=next worker | 1-9 jump | Ctrl+C quit${RESET}`;
  return out;
}
