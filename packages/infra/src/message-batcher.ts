import type { ILogger } from "@co/contracts";

/**
 * Options for configuring the message batcher.
 */
export interface MessageBatcherOptions {
  /** Maximum number of messages to batch before flushing */
  batch_size?: number;
  /** Maximum time (ms) to wait before flushing a partial batch */
  batch_timeout_ms?: number;
  /** Maximum number of retry attempts for failed batch processing */
  max_retries?: number;
  /** Base delay (ms) for exponential backoff on retries */
  retry_base_delay_ms?: number;
  /** Logger instance for debugging */
  logger?: ILogger;
}

/**
 * A single message in the batch.
 */
export interface BatchMessage<T> {
  /** Unique identifier for the message */
  id: string;
  /** The message payload */
  payload: T;
  /** Timestamp when the message was added to the batch */
  added_at: number;
  /** Sequence number for ordering within the batch */
  sequence: number;
}

/**
 * A batch of messages ready for processing.
 */
export interface MessageBatch<T> {
  /** Unique batch identifier */
  id: string;
  /** Messages in the batch, ordered by sequence */
  messages: readonly BatchMessage<T>[];
  /** Timestamp when the batch was created */
  created_at: number;
  /** Number of retry attempts for this batch */
  retry_count: number;
}

/**
 * Callback function for processing a batch of messages.
 * Returns true if processing succeeded, false otherwise.
 */
export type BatchProcessor<T> = (batch: MessageBatch<T>) => Promise<boolean>;

/**
 * MessageBatcher collects messages and processes them in batches to reduce
 * network overhead and improve throughput.
 *
 * Messages are batched by either:
 * - Batch size: flush when batch_size messages accumulated
 * - Time window: flush after batch_timeout_ms regardless of size
 *
 * The batcher preserves message ordering within each batch and supports
 * retry logic with exponential backoff for failed batch processing.
 *
 * @example
 * ```typescript
 * const batcher = new MessageBatcher<{ type: string; data: unknown }>({
 *   batch_size: 10,
 *   batch_timeout_ms: 1000,
 *   logger: logger.child("batcher"),
 * });
 *
 * // Start the batcher with a processor
 * await batcher.start(async (batch) => {
 *   await sendBatchToServer(batch.messages);
 *   return true;
 * });
 *
 * // Add messages
 * batcher.add({ id: "1", payload: { type: "event", data: {...} } });
 *
 * // Shutdown
 * await batcher.stop();
 * ```
 */
export class MessageBatcher<T> {
  private readonly batchSize: number;
  private readonly batchTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly logger?: ILogger;

  private currentBatch: BatchMessage<T>[] = [];
  private sequence = 0;
  private batchId = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private processor: BatchProcessor<T> | null = null;
  private running = false;
  private processing = false;

  // Stats
  private stats = {
    messages_added: 0,
    batches_flushed: 0,
    batches_succeeded: 0,
    batches_failed: 0,
    retries: 0,
  };

  constructor(options: MessageBatcherOptions = {}) {
    this.batchSize = options.batch_size ?? 10;
    this.batchTimeoutMs = options.batch_timeout_ms ?? 1000;
    this.maxRetries = options.max_retries ?? 3;
    this.retryBaseDelayMs = options.retry_base_delay_ms ?? 100;
    this.logger = options.logger;
  }

  /**
   * Start the batcher with a processor function.
   */
  start(processor: BatchProcessor<T>): void {
    if (this.running) {
      throw new Error("MessageBatcher is already running");
    }
    this.processor = processor;
    this.running = true;
    this.logger?.debug("batcher started", {
      batch_size: this.batchSize,
      batch_timeout_ms: this.batchTimeoutMs,
    });
  }

  /**
   * Stop the batcher and flush any remaining messages.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush any remaining messages
    if (this.currentBatch.length > 0) {
      await this.flush();
    }

    this.logger?.debug("batcher stopped", this.getStats());
  }

  /**
   * Add a message to the current batch.
   * If the batch is full, it will be flushed immediately.
   */
  add(message: Omit<BatchMessage<T>, "added_at" | "sequence">): void {
    if (!this.running) {
      throw new Error("MessageBatcher is not running");
    }

    const batchMessage: BatchMessage<T> = {
      ...message,
      added_at: Date.now(),
      sequence: this.sequence++,
    };

    this.currentBatch.push(batchMessage);
    this.stats.messages_added++;

    this.logger?.debug("message added to batch", {
      message_id: message.id,
      batch_size: this.currentBatch.length,
    });

    // Check if batch is full
    if (this.currentBatch.length >= this.batchSize) {
      void this.flush();
    } else if (this.currentBatch.length === 1) {
      // Start timeout for first message in batch
      this.scheduleFlush();
    }
  }

  /**
   * Get current batcher statistics.
   */
  getStats() {
    return {
      ...this.stats,
      pending_messages: this.currentBatch.length,
      running: this.running,
      processing: this.processing,
    };
  }

  /**
   * Get the current batch size configuration.
   */
  getBatchSize(): number {
    return this.batchSize;
  }

  /**
   * Get the current batch timeout configuration.
   */
  getBatchTimeoutMs(): number {
    return this.batchTimeoutMs;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    this.flushTimer = setTimeout(() => {
      void this.flush();
    }, this.batchTimeoutMs);
  }

  private async flush(): Promise<void> {
    if (this.currentBatch.length === 0 || this.processing) return;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Take reference to current batch and create new empty array
    // This avoids copying the array - we just swap references
    const messagesToProcess = this.currentBatch;
    this.currentBatch = [];

    const batch: MessageBatch<T> = {
      id: `batch-${++this.batchId}`,
      messages: messagesToProcess,
      created_at: Date.now(),
      retry_count: 0,
    };

    this.processing = true;

    this.logger?.debug("flushing batch", {
      batch_id: batch.id,
      message_count: batch.messages.length,
    });

    try {
      await this.processBatchWithRetry(batch);
    } finally {
      this.processing = false;

      // If there are new messages waiting, schedule a flush
      if (this.currentBatch.length > 0 && this.running) {
        this.scheduleFlush();
      }
    }
  }

  private async processBatchWithRetry(batch: MessageBatch<T>): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const success = await this.processor!(batch);
        if (success) {
          this.stats.batches_flushed++;
          this.stats.batches_succeeded++;
          this.logger?.debug("batch processed successfully", {
            batch_id: batch.id,
            message_count: batch.messages.length,
            attempt,
          });
          return;
        }
        lastError = new Error("Batch processor returned false");
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger?.debug("batch processing failed", {
          batch_id: batch.id,
          attempt,
          error: lastError.message,
        });
      }

      if (attempt < this.maxRetries) {
        const delay = this.retryBaseDelayMs * Math.pow(2, attempt);
        this.stats.retries++;
        this.logger?.debug("retrying batch", {
          batch_id: batch.id,
          attempt: attempt + 1,
          delay_ms: delay,
        });
        await this.sleep(delay);
      }
    }

    this.stats.batches_flushed++;
    this.stats.batches_failed++;
    this.logger?.error("batch processing failed after retries", {
      batch_id: batch.id,
      message_count: batch.messages.length,
      attempts: this.maxRetries + 1,
      error: lastError?.message,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
