import type {
  IMessageRouter,
  InstanceId,
  Message,
  SendMessageInput,
} from "@co/contracts";
import { MessageBatcher, type BatchMessage } from "./message-batcher.js";

/**
 * Options for the BatchedMessageRouter.
 */
export interface BatchedMessageRouterOptions {
  /** Underlying message router to use for actual sending */
  router: IMessageRouter;
  /** Maximum number of messages to batch before flushing */
  batch_size?: number;
  /** Maximum time (ms) to wait before flushing a partial batch */
  batch_timeout_ms?: number;
  /** Maximum number of retry attempts for failed batch processing */
  max_retries?: number;
  /** Base delay (ms) for exponential backoff on retries */
  retry_base_delay_ms_ms?: number;
  /** Logger instance for debugging */
  logger?: { debug: (msg: string, ctx?: Record<string, unknown>) => void; error: (msg: string, ctx?: Record<string, unknown>) => void };
}

/**
 * A message with its send input for batching.
 */
interface PendingMessage {
  input: SendMessageInput;
  instanceId: InstanceId;
}

/**
 * BatchedMessageRouter wraps an IMessageRouter and batches messages to reduce
 * network overhead and improve throughput.
 *
 * Messages are collected and sent in batches based on:
 * - Batch size: flush when batch_size messages accumulated
 * - Time window: flush after batch_timeout_ms regardless of size
 *
 * Message ordering is preserved within each batch. Failed batches are
 * retried with exponential backoff.
 *
 * @example
 * ```typescript
 * const batchedRouter = new BatchedMessageRouter({
 *   router: messageRouter,
 *   batch_size: 5,
 *   batch_timeout_ms: 500,
 *   logger: logger.child("batched-router"),
 * });
 *
 * await batchedRouter.start();
 *
 * // Messages are automatically batched
 * await batchedRouter.send({
 *   type: "direct",
 *   from_instance: leaderId,
 *   from_name: "Leader",
 *   to_instance: workerId,
 *   content: "Hello",
 * });
 *
 * await batchedRouter.stop();
 * ```
 */
export class BatchedMessageRouter {
  private readonly router: IMessageRouter;
  private readonly batcher: MessageBatcher<PendingMessage>;
  private readonly logger?: { debug: (msg: string, ctx?: Record<string, unknown>) => void; error: (msg: string, ctx?: Record<string, unknown>) => void };
  private running = false;

  constructor(options: BatchedMessageRouterOptions) {
    this.router = options.router;
    this.logger = options.logger;

    this.batcher = new MessageBatcher<PendingMessage>({
      batch_size: options.batch_size ?? 10,
      batch_timeout_ms: options.batch_timeout_ms ?? 1000,
      max_retries: options.max_retries ?? 3,
      retry_base_delay_ms: options.retry_base_delay_ms_ms ?? 100,
      logger: options.logger as Parameters<typeof MessageBatcher>[0]["logger"],
    });
  }

  /**
   * Start the batched router.
   */
  start(): void {
    if (this.running) {
      throw new Error("BatchedMessageRouter is already running");
    }

    this.batcher.start(async (batch) => {
      this.logger?.debug("processing batch", {
        batch_id: batch.id,
        message_count: batch.messages.length,
      });

      try {
        // Process messages in order within the batch
        const results = await Promise.allSettled(
          batch.messages.map(async (msg) => {
            const result = await this.router.send(msg.payload.input);
            return { original: msg.payload, sent: result };
          })
        );

        // Check if all messages were sent successfully
        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length > 0) {
          this.logger?.error("batch partially failed", {
            batch_id: batch.id,
            failures: failures.length,
            total: batch.messages.length,
          });
          // Return false to trigger retry for the entire batch
          return false;
        }

        this.logger?.debug("batch processed successfully", {
          batch_id: batch.id,
          message_count: batch.messages.length,
        });
        return true;
      } catch (err) {
        this.logger?.error("batch processing error", {
          batch_id: batch.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    });

    this.running = true;
    this.logger?.debug("batched router started");
  }

  /**
   * Stop the batched router and flush any remaining messages.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    await this.batcher.stop();
    this.running = false;
    this.logger?.debug("batched router stopped");
  }

  /**
   * Send a message. The message will be added to the current batch.
   * Returns immediately without waiting for the message to be sent.
   */
  send(input: SendMessageInput): void {
    if (!this.running) {
      throw new Error("BatchedMessageRouter is not running");
    }

    if (!input.to_instance) {
      throw new Error("send() requires to_instance");
    }

    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.batcher.add({
      id,
      payload: { input, instanceId: input.to_instance },
    });
  }

  /**
   * Get current router statistics.
   */
  getStats() {
    return {
      ...this.batcher.getStats(),
      running: this.running,
    };
  }

  /**
   * Get the underlying message router.
   */
  getRouter(): IMessageRouter {
    return this.router;
  }
}
