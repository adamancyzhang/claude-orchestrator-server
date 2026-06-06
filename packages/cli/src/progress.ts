/**
 * Progress indicator for long-running CLI operations.
 * Supports both TTY (with spinner) and non-TTY (with dots) environments.
 */

export interface ProgressOptions {
  /** Message to display next to the spinner */
  message: string;
  /** Whether to disable progress output */
  disabled?: boolean;
}

export class ProgressIndicator {
  private message: string;
  private disabled: boolean;
  private isTTY: boolean;
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private dotCount = 0;
  private startTime: number;
  private isRunning = false;

  // Spinner frames for TTY
  private static readonly SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  // Dots for non-TTY
  private static readonly DOT_INTERVAL = 500;

  constructor(options: ProgressOptions) {
    this.message = options.message;
    this.disabled = options.disabled ?? false;
    this.isTTY = Boolean(process.stdout.isTTY);
    this.startTime = Date.now();
  }

  /**
   * Start the progress indicator.
   */
  start(): void {
    if (this.disabled || this.isRunning) return;

    this.isRunning = true;
    this.startTime = Date.now();

    if (this.isTTY) {
      // TTY: show animated spinner
      this.spinnerInterval = setInterval(() => {
        this.frameIndex = (this.frameIndex + 1) % ProgressIndicator.SPINNER_FRAMES.length;
        const frame = ProgressIndicator.SPINNER_FRAMES[this.frameIndex];
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        process.stdout.write(`\r${frame} ${this.message} (${elapsed}s)`);
      }, 80);
    } else {
      // Non-TTY: show dots
      this.spinnerInterval = setInterval(() => {
        this.dotCount = (this.dotCount + 1) % 4;
        const dots = ".".repeat(this.dotCount);
        process.stdout.write(`${this.message}${dots}\n`);
      }, ProgressIndicator.DOT_INTERVAL);
    }
  }

  /**
   * Stop the progress indicator and show completion message.
   */
  stop(completeMessage?: string): void {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }

    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);

    if (this.isTTY) {
      // Clear the spinner line
      process.stdout.write("\r" + " ".repeat(50) + "\r");
      if (completeMessage) {
        console.log(`${completeMessage} (${elapsed}s)`);
      }
    } else {
      // Non-TTY: just print completion
      if (completeMessage) {
        console.log(`${completeMessage} (${elapsed}s)`);
      }
    }
  }

  /**
   * Update the displayed message.
   */
  updateMessage(message: string): void {
    this.message = message;
  }

  /**
   * Check if the indicator is currently running.
   */
  isRunningIndicator(): boolean {
    return this.isRunning;
  }
}

/**
 * Create a progress indicator with the given message.
 * Convenience function that returns a new ProgressIndicator instance.
 */
export function createProgress(message: string, disabled?: boolean): ProgressIndicator {
  return new ProgressIndicator({ message, disabled });
}
