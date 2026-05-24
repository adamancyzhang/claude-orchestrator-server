import type { IEventBus, ILeaderStateView, LeaderEvent } from "@co/contracts";
import type { LeaderState } from "../state.js";

export interface StateSnapshot {
  readonly workers: ILeaderStateView["workers"];
  readonly pending_tasks: ILeaderStateView["pending_tasks"];
  readonly in_progress_tasks: ILeaderStateView["in_progress_tasks"];
  readonly events: ILeaderStateView["events"];
  readonly selected_worker_index: number;
  readonly magic_mode: boolean;
  readonly magic_max_chains: number | null;
}

export interface StateStore {
  subscribe(fn: () => void): () => void;
  getSnapshot(): StateSnapshot;
  destroy(): void;
}

function snapshotState(state: LeaderState): StateSnapshot {
  return {
    workers: state.workers,
    pending_tasks: state.pending_tasks,
    in_progress_tasks: state.in_progress_tasks,
    events: state.events,
    selected_worker_index: state.selected_worker_index,
    magic_mode: state.magic_mode,
    magic_max_chains: state.magic_max_chains,
  };
}

export function createStateStore(
  bus: IEventBus<LeaderEvent>,
  state: LeaderState,
): StateStore {
  let version = 0;
  let cachedVersion = -1;
  let cachedSnapshot: StateSnapshot | null = null;
  const listeners = new Set<() => void>();

  const unsub = bus.onAny(() => {
    version++;
    for (const fn of listeners) fn();
  });

  return {
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot() {
      if (version !== cachedVersion) {
        cachedVersion = version;
        cachedSnapshot = snapshotState(state);
      }
      return cachedSnapshot!;
    },
    destroy() {
      unsub();
      listeners.clear();
    },
  };
}
