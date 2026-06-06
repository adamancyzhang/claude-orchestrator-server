import type { ILogger } from "@co/contracts";

export interface ShutdownOptions {
  /** Maximum time to wait for graceful shutdown before forcing exit (ms) */
  timeout_ms?: number;
  /** Logger instance for shutdown phase logging */
  logger?: ILogger;
}

export interface ShutdownPhase {
  name: string;
  handler: () => Promise<void>;
}

/**
 * Manages graceful shutdown with phase-based cleanup and forced timeout.
 *
 * Usage:
 * 1. Create instance with options
 * 2. Register shutdown phases via addPhase()
 * 3. Register signal handlers via registerSignals()
 * 4. Trigger shutdown via shutdown()
 */
export class GracefulShutdown {
  private phases: ShutdownPhase[] = [];
  private isShuttingDown = false;
  private timeout_ms: number;
  private logger: ILogger;

  constructor(options: ShutdownOptions = {}) {
    this.timeout_ms = options.timeout_ms ?? 30_000;
    this.logger = options.logger ?? {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => this.logger,
    };
  }

  /**
   * Add a shutdown phase. Phases execute in order.
   * @param name - Human-readable phase name for logging
   * @param handler - Async function to execute during this phase
   */
  addPhase(name: string, handler: () => Promise<void>): void {
    this.phases.push({ name, handler });
  }

  /**
   * Register SIGINT and SIGTERM handlers.
   * @returns Cleanup function to remove signal handlers
   */
  registerSignals(): () => void {
    const onSignal = () => {
      void this.shutdown();
    };

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    return () => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };
  }

  /**
   * Trigger graceful shutdown.
   * - Executes all registered phases in order
   * - Enforces timeout_ms limit
   * - Calls process.exit(1) if timeout exceeded
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn("shutdown already in progress, ignoring duplicate signal");
      return;
    }

    this.isShuttingDown = true;
    const startTime = Date.now();

    this.logger.info("graceful shutdown initiated", {
      timeout_ms: this.timeout_ms,
      phase_count: this.phases.length,
    });

    // Set up forced exit timer
    const forceExitTimer = setTimeout(() => {
      const elapsed = Date.now() - startTime;
      this.logger.error("shutdown timeout exceeded, forcing exit", {
        elapsed_ms: elapsed,
        timeout_ms: this.timeout_ms,
      });
      process.exit(1);
    }, this.timeout_ms);

    // Don't let the timer keep the process alive
    forceExitTimer.unref();

    try {
      for (let i = 0; i < this.phases.length; i++) {
        const phase = this.phases[i];
        const phaseStart = Date.now();
        this.logger.info("shutdown phase starting", {
          phase: phase.name,
          phase_index: i + 1,
          total_phases: this.phases.length,
        });

        try {
          await phase.handler();
          const phaseDuration = Date.now() - phaseStart;
          this.logger.info("shutdown phase completed", {
            phase: phase.name,
            duration_ms: phaseDuration,
          });
        } catch (err) {
          const phaseDuration = Date.now() - phaseStart;
          this.logger.error("shutdown phase failed", {
            phase: phase.name,
            duration_ms: phaseDuration,
            error: err instanceof Error ? err.message : String(err),
          });
          // Continue to next phase even if this one failed
        }
      }

      const totalDuration = Date.now() - startTime;
      this.logger.info("graceful shutdown completed", {
        total_duration_ms: totalDuration,
        phases_executed: this.phases.length,
      });
    } finally {
      clearTimeout(forceExitTimer);
    }
  }

  /**
   * Check if shutdown is in progress.
   */
  getShuttingDown(): boolean {
    return this.isShuttingDown;
  }
}
