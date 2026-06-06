import * as fs from "node:fs";
import * as path from "node:path";
import type { ILogger } from "@co/contracts";

export type StateUpdateCallback = (state: Record<string, unknown>) => void;

/**
 * Watches the orchestrator state.json file for changes.
 * Uses fs.watch with debouncing to avoid excessive updates.
 */
export class StateWatcher {
  private state_dir: string;
  private logger?: ILogger;
  private watcher: fs.FSWatcher | null = null;
  private debounce_timer: ReturnType<typeof setTimeout> | null = null;
  private callback: StateUpdateCallback | null = null;
  private last_content: string | null = null;

  constructor(state_dir: string, logger?: ILogger) {
    this.state_dir = state_dir;
    this.logger = logger;
  }

  /**
   * Register a callback for state updates.
   */
  onUpdate(callback: StateUpdateCallback): void {
    this.callback = callback;
  }

  /**
   * Start watching for state changes.
   */
  start(): void {
    const state_path = path.join(this.state_dir, "state.json");

    // Ensure state directory exists
    if (!fs.existsSync(this.state_dir)) {
      fs.mkdirSync(this.state_dir, { recursive: true });
    }

    // Read initial state
    this.readAndNotify();

    // Watch for changes
    try {
      this.watcher = fs.watch(this.state_dir, (event, filename) => {
        if (filename === "state.json") {
          this.debounce();
        }
      });

      this.logger?.info("state watcher started", { state_dir: this.state_dir });
    } catch (err) {
      this.logger?.error("failed to start state watcher", { error: String(err) });
    }
  }

  /**
   * Stop watching for state changes.
   */
  stop(): void {
    if (this.debounce_timer) {
      clearTimeout(this.debounce_timer);
      this.debounce_timer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    this.logger?.info("state watcher stopped");
  }

  /**
   * Debounce state reads to avoid excessive updates.
   */
  private debounce(): void {
    if (this.debounce_timer) {
      clearTimeout(this.debounce_timer);
    }

    this.debounce_timer = setTimeout(() => {
      this.readAndNotify();
    }, 100); // 100ms debounce
  }

  /**
   * Read state file and notify callback if changed.
   */
  private readAndNotify(): void {
    const state_path = path.join(this.state_dir, "state.json");

    try {
      if (!fs.existsSync(state_path)) {
        return;
      }

      const content = fs.readFileSync(state_path, "utf-8");

      // Only notify if content changed
      if (content !== this.last_content) {
        this.last_content = content;
        const state = JSON.parse(content);
        this.callback?.(state);
      }
    } catch (err) {
      this.logger?.debug("failed to read state file", { error: String(err) });
    }
  }
}
