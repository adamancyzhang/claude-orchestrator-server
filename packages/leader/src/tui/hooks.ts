import { useSyncExternalStore } from "react";
import type { StateSnapshot, StateStore } from "./store.js";

export function useLeaderSnapshot(store: StateStore): StateSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
