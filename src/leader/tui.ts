import { LeaderState } from "./state.js";
import {
  CLEAR, HIDE_CURSOR, SHOW_CURSOR, RESET, BOLD, DIM,
  MIN_COLS, MIN_ROWS,
  box,
  defaultUiState,
  renderTeamGrid,
  renderPendingTasks,
  renderClaimedTasks,
  renderWorkerMessages,
  renderStreamPanel,
  renderEventLog,
  renderInputLine,
  renderFooter,
  renderTerminalTooSmall,
  renderHelpOverlay,
  type TuiUiState,
} from "./tui-render.js";

const SENT_INDICATOR_MS = 2000;

/**
 * Handle a single raw key event. Pure-ish: mutates `ui` and optionally `state`
 * (the parts of state that are TUI selection — e.g. selectedWorkerIndex), and
 * may invoke `onSubmit` when Enter is pressed with non-empty buffer.
 *
 * Returns true if anything changed and the caller should rerender.
 */
export function handleKey(
  key: string,
  state: LeaderState,
  ui: TuiUiState,
  onSubmit: (text: string) => void,
  nowMs: number = Date.now(),
): boolean {
  // Ctrl+C — propagate signal
  if (key === "\x03") {
    process.kill(process.pid, "SIGINT");
    return false;
  }

  // Ctrl+L — force redraw (no state change needed)
  if (key === "\x0c") {
    return true;
  }

  // Help overlay toggle (?)
  if (key === "?") {
    ui.showHelp = !ui.showHelp;
    return true;
  }

  // If help overlay is showing, only ?/Esc/Ctrl+C reach this point
  if (ui.showHelp && key === "\x1b") {
    ui.showHelp = false;
    return true;
  }

  // Tab — next worker
  if (key === "\t") {
    if (state.workers.length > 0) {
      state.selectedWorkerIndex = (state.selectedWorkerIndex + 1) % state.workers.length;
      // Reset stream scroll when changing worker
      ui.streamScrollOffset = 0;
      return true;
    }
    return false;
  }

  // Shift+Tab — previous worker
  if (key === "\x1b[Z") {
    if (state.workers.length > 0) {
      state.selectedWorkerIndex =
        (state.selectedWorkerIndex - 1 + state.workers.length) % state.workers.length;
      ui.streamScrollOffset = 0;
      return true;
    }
    return false;
  }

  // Ctrl+P — pause/resume stream
  if (key === "\x10") {
    ui.streamPaused = !ui.streamPaused;
    return true;
  }

  // Arrow up — scroll stream older
  if (key === "\x1b[A") {
    ui.streamScrollOffset += 5;
    return true;
  }
  // Arrow down — scroll stream newer
  if (key === "\x1b[B") {
    ui.streamScrollOffset = Math.max(0, ui.streamScrollOffset - 5);
    return true;
  }
  // End — follow (reset scroll)
  if (key === "\x1b[F" || key === "\x1b[4~") {
    ui.streamScrollOffset = 0;
    return true;
  }

  // f — cycle event filter (only when not actively composing a message)
  if (key === "f" && ui.inputBuffer.length === 0) {
    const order: TuiUiState["eventFilter"][] = ["all", "task", "worker", "chain"];
    const i = order.indexOf(ui.eventFilter);
    ui.eventFilter = order[(i + 1) % order.length];
    return true;
  }

  // Digit jump
  if (key >= "1" && key <= "9") {
    const idx = parseInt(key, 10) - 1;
    if (idx < state.workers.length) {
      state.selectedWorkerIndex = idx;
      ui.streamScrollOffset = 0;
      return true;
    }
    return false;
  }

  // Enter — submit
  if (key === "\r" || key === "\n") {
    const text = ui.inputBuffer.trim();
    if (text) {
      ui.pendingInput = text;
      ui.sentAt = nowMs;
      onSubmit(text);
    }
    ui.inputBuffer = "";
    return true;
  }

  // Backspace
  if (key === "\x7f" || key === "\x08") {
    if (ui.inputBuffer.length > 0) {
      ui.inputBuffer = ui.inputBuffer.slice(0, -1);
      return true;
    }
    return false;
  }

  // Esc — clear input
  if (key === "\x1b") {
    if (ui.inputBuffer.length > 0) {
      ui.inputBuffer = "";
      return true;
    }
    return false;
  }

  // Printable
  if (key >= " " && key.length < 16) {
    ui.inputBuffer += key;
    return true;
  }

  return false;
}

/**
 * Compose the full TUI frame from state + ui. Pure — returns the string to write.
 */
export function composeFrame(state: LeaderState, ui: TuiUiState, cols: number, rows: number, nowMs: number): string {
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    return CLEAR + HIDE_CURSOR + renderTerminalTooSmall(cols, rows).join("\n");
  }

  if (ui.showHelp) {
    const lines = renderHelpOverlay(cols);
    while (lines.length < rows - 2) lines.push("");
    return CLEAR + HIDE_CURSOR + box(cols - 2, ...lines);
  }

  let out = CLEAR + HIDE_CURSOR;
  const halfW = Math.floor((cols - 4) / 2);

  // Team
  const teamLines = renderTeamGrid(state.workers, state.selectedWorkerIndex, cols - 2);
  out += box(cols - 2, ...teamLines);
  const teamBoxH = teamLines.length + 2;

  // Tasks (side by side)
  const pendLines = renderPendingTasks(state.pendingTasks, halfW);
  const progLines = renderClaimedTasks(state.claimedTasks, halfW);
  const taskH = Math.max(pendLines.length, progLines.length) + 2;
  while (pendLines.length < taskH - 2) pendLines.push("");
  while (progLines.length < taskH - 2) progLines.push("");
  const leftBox = box(halfW, ...pendLines).split("\n");
  const rightBox = box(halfW, ...progLines).split("\n");
  for (let i = 0; i < leftBox.length; i++) {
    out += leftBox[i] + " " + rightBox[i] + "\n";
  }

  // Stream / messages
  const msgWidth = cols - 2;
  const selected = state.workers[state.selectedWorkerIndex];
  let msgLines: string[] = [];
  if (selected) {
    if (selected.streamActive || selected.streamBuffer.length > 0) {
      msgLines = renderStreamPanel(selected, msgWidth, 14, ui);
    } else {
      msgLines = [
        ` ${BOLD}WORKER MESSAGES${RESET} — ${selected.name} (${selected.presetRole})`,
        ` ${DIM}${"─".repeat(Math.max(1, msgWidth - 4))}${RESET}`,
        ...renderWorkerMessages(selected, msgWidth, 10),
      ];
    }
  } else {
    msgLines = [` ${DIM}No workers${RESET}`];
  }
  while (msgLines.length < 12) msgLines.push("");
  const msgH = msgLines.length + 2;
  out += box(msgWidth, ...msgLines);

  // Event log (fills remaining height)
  const inputSectionH = 4;
  const remainingH = rows - teamBoxH - (taskH + 2) - msgH - inputSectionH - 3;
  const logH = Math.max(remainingH, 3);
  const logLines = renderEventLog(state.events, logH, cols - 2, ui.eventFilter);
  while (logLines.length < logH - 1) logLines.push("");
  out += box(cols - 2, ...logLines);

  // Input
  const inputStatus = { pendingInput: ui.pendingInput, sentAt: ui.sentAt, nowMs };
  const { line, hint } = renderInputLine(ui.inputBuffer, inputStatus);
  out += box(cols - 2, line, hint);

  // Footer
  out += `\n${renderFooter(cols, state.leaderName, state.leaderInstanceId, state.cacheDir, nowMs)}`;
  return out;
}

export class LeaderTui {
  private ui: TuiUiState = defaultUiState();
  private inputCallback: ((text: string) => void) | null = null;
  private rawMode = false;
  private state: LeaderState | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private renderQueued = false;
  private renderDebounceMs = 50;

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

  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setTimeout(() => {
      this.renderQueued = false;
      this.rerender();
    }, this.renderDebounceMs);
  }

  private setupResizeHandler(): void {
    process.stdout.on("resize", () => this.rerender());
  }

  private startRefreshTimer(): void {
    this.refreshTimer = setInterval(() => {
      // Clear the sent indicator after expiry so the hint reverts naturally.
      if (this.ui.sentAt && Date.now() - this.ui.sentAt > SENT_INDICATOR_MS) {
        this.ui.pendingInput = null;
        this.ui.sentAt = null;
      }
      this.rerender();
    }, 1000);
  }

  private setupInput(): void {
    process.stdin.on("data", (data: Buffer) => {
      const key = data.toString();
      const dirty = handleKey(key, this.state ?? new LeaderState(), this.ui, (text) => {
        if (this.inputCallback) this.inputCallback(text);
      });
      if (dirty) this.rerender();
    });
  }

  render(state: LeaderState): void {
    this.state = state;
    this.enableRawMode();
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 30;
    const out = composeFrame(state, this.ui, cols, rows, Date.now());
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
