import type { ILeaderStateView } from "@co/contracts";
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface StateFile {
  version: number;
  updated_at: string;
  magic_mode: boolean;
  magic_max_chains: number | null;
  workers: readonly ILeaderStateView["workers"][number][];
  pending_tasks: readonly ILeaderStateView["pending_tasks"][number][];
  in_progress_tasks: readonly ILeaderStateView["in_progress_tasks"][number][];
  events: readonly ILeaderStateView["events"][number][];
}

const DEFAULT_INTERVAL_MS = 500;

export class StateWriter {
  private readonly _stateView: ILeaderStateView;
  private readonly _stateDir: string;
  private readonly _intervalMs: number;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _lastWrite = 0;

  constructor(stateView: ILeaderStateView, stateDir: string, intervalMs?: number) {
    this._stateView = stateView;
    this._stateDir = stateDir;
    this._intervalMs = intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (this._timer !== null) return;
    this._write(); // immediate first write
    this._timer = setInterval(() => this._write(), this._intervalMs);
  }

  stop(): void {
    if (this._timer === null) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  private _write(): void {
    mkdirSync(this._stateDir, { recursive: true });

    const state: StateFile = {
      version: 1,
      updated_at: new Date().toISOString(),
      magic_mode: this._stateView.magic_mode,
      magic_max_chains: this._stateView.magic_max_chains,
      workers: this._stateView.workers as StateFile["workers"],
      pending_tasks: this._stateView.pending_tasks as StateFile["pending_tasks"],
      in_progress_tasks: this._stateView.in_progress_tasks as StateFile["in_progress_tasks"],
      events: this._stateView.events as StateFile["events"],
    };

    const filePath = join(this._stateDir, "state.json");
    const tmpPath = filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    renameSync(tmpPath, filePath);
    this._lastWrite = Date.now();
  }
}
