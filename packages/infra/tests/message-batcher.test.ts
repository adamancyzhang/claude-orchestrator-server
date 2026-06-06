import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessageBatcher } from "../src/message-batcher.js";
import type { BatchMessage, MessageBatch } from "../src/message-batcher.js";

describe("MessageBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic functionality", () => {
    it("should create a batcher with default options", () => {
      const batcher = new MessageBatcher();
      const stats = batcher.getStats();

      expect(stats.messages_added).toBe(0);
      expect(stats.batches_flushed).toBe(0);
      expect(stats.running).toBe(false);
      expect(batcher.getBatchSize()).toBe(10);
      expect(batcher.getBatchTimeoutMs()).toBe(1000);
    });

    it("should create a batcher with custom options", () => {
      const batcher = new MessageBatcher({
        batch_size: 5,
        batch_timeout_ms: 500,
        max_retries: 5,
        retry_base_delay_ms: 200,
      });

      expect(batcher.getBatchSize()).toBe(5);
      expect(batcher.getBatchTimeoutMs()).toBe(500);
    });

    it("should start and stop the batcher", async () => {
      const batcher = new MessageBatcher();
      const processor = vi.fn().mockResolvedValue(true);

      batcher.start(processor);
      expect(batcher.getStats().running).toBe(true);

      await batcher.stop();
      expect(batcher.getStats().running).toBe(false);
    });

    it("should throw when starting already running batcher", () => {
      const batcher = new MessageBatcher();
      const processor = vi.fn().mockResolvedValue(true);

      batcher.start(processor);
      expect(() => batcher.start(processor)).toThrow("already running");
    });

    it("should throw when adding message to stopped batcher", () => {
      const batcher = new MessageBatcher();
      const processor = vi.fn().mockResolvedValue(true);

      expect(() =>
        batcher.add({ id: "1", payload: "test" })
      ).toThrow("not running");
    });
  });

  describe("batching by size", () => {
    it("should flush when batch size is reached", async () => {
      const batcher = new MessageBatcher({ batch_size: 3 });
      const processor = vi.fn().mockResolvedValue(true);

      batcher.start(processor);

      batcher.add({ id: "1", payload: "msg1" });
      batcher.add({ id: "2", payload: "msg2" });
      expect(processor).not.toHaveBeenCalled();

      batcher.add({ id: "3", payload: "msg3" });
      // Wait for async processing
      await vi.advanceTimersByTimeAsync(0);

      expect(processor).toHaveBeenCalledTimes(1);
      const batch = processor.mock.calls[0][0] as MessageBatch<string>;
      expect(batch.messages).toHaveLength(3);
      expect(batch.messages[0].payload).toBe("msg1");
      expect(batch.messages[1].payload).toBe("msg2");
      expect(batch.messages[2].payload).toBe("msg3");

      await batcher.stop();
    });

    it("should preserve message ordering within batch", async () => {
      const batcher = new MessageBatcher({ batch_size: 5 });
      const processor = vi.fn().mockResolvedValue(true);

      batcher.start(processor);

      // Add messages in specific order
      for (let i = 0; i < 5; i++) {
        batcher.add({ id: `msg-${i}`, payload: `payload-${i}` });
      }

      await vi.advanceTimersByTimeAsync(0);

      const batch = processor.mock.calls[0][0] as MessageBatch<string>;
      expect(batch.messages[0].payload).toBe("payload-0");
      expect(batch.messages[1].payload).toBe("payload-1");
      expect(batch.messages[2].payload).toBe("payload-2");
      expect(batch.messages[3].payload).toBe("payload-3");
      expect(batch.messages[4].payload).toBe("payload-4");

      // Verify sequence numbers are in order
      for (let i = 0; i < 5; i++) {
        expect(batch.messages[i].sequence).toBe(i);
      }

      await batcher.stop();
    });

    it("should create multiple batches when messages exceed batch size", async () => {
      const batcher = new MessageBatcher({ batch_size: 2 });
      const processor = vi.fn().mockResolvedValue(true);

      batcher.start(processor);

      batcher.add({ id: "1", payload: "msg1" });
      batcher.add({ id: "2", payload: "msg2" });
      await vi.advanceTimersByTimeAsync(0);

      batcher.add({ id: "3", payload: "msg3" });
      batcher.add({ id: "4", payload: "msg4" });
      await vi.advanceTimersByTimeAsync(0);

      expect(processor).toHaveBeenCalledTimes(2);
      expect(batcher.getStats().batches_flushed).toBe(2);

      await batcher.stop();
    });
  });

  describe("batching by time", () => {
    it("should flush after timeout even if batch is not full", async () => {
      const batcher = new MessageBatcher({ batch_timeout_ms: 1000 });
      const processor = vi.fn().mockResolvedValue(true);

      batcher.start(processor);

      batcher.add({ id: "1", payload: "msg1" });
      batcher.add({ id: "2", payload: "msg2" });

      // Not yet flushed
      expect(processor).not.toHaveBeenCalled();

      // Advance time past timeout
      await vi.advanceTimersByTimeAsync(1000);

      expect(processor).toHaveBeenCalledTimes(1);
      const batch = processor.mock.calls[0][0] as MessageBatch<string>;
      expect(batch.messages).toHaveLength(2);

      await batcher.stop();
    });

    it("should include all messages added before timeout", async () => {
      const batcher = new MessageBatcher({ batch_timeout_ms: 500 });
      const processor = vi.fn().mockResolvedValue(true);

      batcher.start(processor);

      // Add messages at different times
      batcher.add({ id: "1", payload: "msg1" });
      await vi.advanceTimersByTimeAsync(100);
      batcher.add({ id: "2", payload: "msg2" });
      await vi.advanceTimersByTimeAsync(100);
      batcher.add({ id: "3", payload: "msg3" });

      // Not yet flushed
      expect(processor).not.toHaveBeenCalled();

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(500);

      expect(processor).toHaveBeenCalledTimes(1);
      const batch = processor.mock.calls[0][0] as MessageBatch<string>;
      expect(batch.messages).toHaveLength(3);
      expect(batch.messages[0].payload).toBe("msg1");
      expect(batch.messages[1].payload).toBe("msg2");
      expect(batch.messages[2].payload).toBe("msg3");

      await batcher.stop();
    });
  });

  describe("retry logic", () => {
    it("should retry failed batch processing", async () => {
      const batcher = new MessageBatcher({
        batch_size: 1,
        max_retries: 2,
        retry_base_delay_ms: 10,
      });
      const processor = vi.fn()
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockResolvedValueOnce(true);

      batcher.start(processor);

      batcher.add({ id: "1", payload: "msg1" });

      // Wait for retries
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);

      expect(processor).toHaveBeenCalledTimes(3);
      expect(batcher.getStats().retries).toBe(2);
      expect(batcher.getStats().batches_succeeded).toBe(1);

      await batcher.stop();
    });

    it("should fail after max retries exceeded", async () => {
      const batcher = new MessageBatcher({
        batch_size: 1,
        max_retries: 1,
        retry_base_delay_ms: 10,
      });
      const processor = vi.fn().mockRejectedValue(new Error("persistent failure"));

      batcher.start(processor);

      batcher.add({ id: "1", payload: "msg1" });

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);

      expect(processor).toHaveBeenCalledTimes(2); // initial + 1 retry
      expect(batcher.getStats().batches_failed).toBe(1);

      await batcher.stop();
    });

    it("should retry when processor returns false", async () => {
      const batcher = new MessageBatcher({
        batch_size: 1,
        max_retries: 1,
        retry_base_delay_ms: 10,
      });
      const processor = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      batcher.start(processor);

      batcher.add({ id: "1", payload: "msg1" });

      await vi.advanceTimersByTimeAsync(100);

      expect(processor).toHaveBeenCalledTimes(2);
      expect(batcher.getStats().batches_succeeded).toBe(1);

      await batcher.stop();
    });

    it("should use exponential backoff for retries", async () => {
      const batcher = new MessageBatcher({
        batch_size: 1,
        max_retries: 3,
        retry_base_delay_ms: 100,
      });
      const processor = vi.fn()
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockRejectedValueOnce(new Error("fail 3"))
        .mockResolvedValueOnce(true);

      batcher.start(processor);

      batcher.add({ id: "1", payload: "msg1" });

      // First attempt fails immediately
      expect(processor).toHaveBeenCalledTimes(1);

      // First retry after 100ms
      await vi.advanceTimersByTimeAsync(100);
      expect(processor).toHaveBeenCalledTimes(2);

      // Second retry after 200ms (exponential backoff)
      await vi.advanceTimersByTimeAsync(200);
      expect(processor).toHaveBeenCalledTimes(3);

      // Third retry after 400ms
      await vi.advanceTimersByTimeAsync(400);
      expect(processor).toHaveBeenCalledTimes(4);

      await batcher.stop();
    });
  });

  describe("flush on stop", () => {
    it("should flush remaining messages on stop", async () => {
      const batcher = new MessageBatcher({ batch_size: 5 });
      const processor = vi.fn().mockResolvedValue(true);

      batcher.start(processor);

      batcher.add({ id: "1", payload: "msg1" });
      batcher.add({ id: "2", payload: "msg2" });

      expect(processor).not.toHaveBeenCalled();

      await batcher.stop();

      expect(processor).toHaveBeenCalledTimes(1);
      const batch = processor.mock.calls[0][0] as MessageBatch<string>;
      expect(batch.messages).toHaveLength(2);
    });

    it("should not flush if batch is empty", async () => {
      const batcher = new MessageBatcher();
      const processor = vi.fn().mockResolvedValue(true);

      batcher.start(processor);
      await batcher.stop();

      expect(processor).not.toHaveBeenCalled();
    });
  });

  describe("batch metadata", () => {
    it("should include batch id and created_at timestamp", async () => {
      const batcher = new MessageBatcher({ batch_size: 1 });
      const processor = vi.fn().mockResolvedValue(true);

      batcher.start(processor);

      const before = Date.now();
      batcher.add({ id: "1", payload: "msg1" });
      await vi.advanceTimersByTimeAsync(0);
      const after = Date.now();

      const batch = processor.mock.calls[0][0] as MessageBatch<string>;
      expect(batch.id).toMatch(/^batch-\d+$/);
      expect(batch.created_at).toBeGreaterThanOrEqual(before);
      expect(batch.created_at).toBeLessThanOrEqual(after);
      expect(batch.retry_count).toBe(0);

      await batcher.stop();
    });

    it("should include message metadata", async () => {
      const batcher = new MessageBatcher({ batch_size: 1 });
      const processor = vi.fn().mockResolvedValue(true);

      batcher.start(processor);

      const before = Date.now();
      batcher.add({ id: "test-id", payload: "test-payload" });
      await vi.advanceTimersByTimeAsync(0);
      const after = Date.now();

      const batch = processor.mock.calls[0][0] as MessageBatch<string>;
      const msg = batch.messages[0];
      expect(msg.id).toBe("test-id");
      expect(msg.payload).toBe("test-payload");
      expect(msg.added_at).toBeGreaterThanOrEqual(before);
      expect(msg.added_at).toBeLessThanOrEqual(after);
      expect(msg.sequence).toBe(0);

      await batcher.stop();
    });
  });

  describe("statistics", () => {
    it("should track messages added", async () => {
      const batcher = new MessageBatcher({ batch_size: 10 });
      const processor = vi.fn().mockResolvedValue(true);

      batcher.start(processor);

      batcher.add({ id: "1", payload: "msg1" });
      batcher.add({ id: "2", payload: "msg2" });
      batcher.add({ id: "3", payload: "msg3" });

      const stats = batcher.getStats();
      expect(stats.messages_added).toBe(3);
      expect(stats.pending_messages).toBe(3);

      await batcher.stop();
    });

    it("should track batches flushed and succeeded", async () => {
      const batcher = new MessageBatcher({ batch_size: 2 });
      const processor = vi.fn().mockResolvedValue(true);

      batcher.start(processor);

      batcher.add({ id: "1", payload: "msg1" });
      batcher.add({ id: "2", payload: "msg2" });
      await vi.advanceTimersByTimeAsync(0);

      const stats = batcher.getStats();
      expect(stats.batches_flushed).toBe(1);
      expect(stats.batches_succeeded).toBe(1);
      expect(stats.pending_messages).toBe(0);

      await batcher.stop();
    });
  });

  describe("concurrent access", () => {
    it("should not flush while processing is in progress", async () => {
      const batcher = new MessageBatcher({ batch_size: 1 });
      let processing = false;
      let resolveProcessing: () => void;
      const processorPromise = new Promise<boolean>((resolve) => {
        resolveProcessing = () => resolve(true);
      });
      const processor = vi.fn().mockImplementation(async () => {
        processing = true;
        await processorPromise;
        processing = false;
        return true;
      });

      batcher.start(processor);

      batcher.add({ id: "1", payload: "msg1" });
      await vi.advanceTimersByTimeAsync(0);

      expect(processing).toBe(true);

      // Add more messages while processing
      batcher.add({ id: "2", payload: "msg2" });

      // Complete the first processing
      resolveProcessing!();
      await vi.advanceTimersByTimeAsync(0);

      expect(processor).toHaveBeenCalledTimes(1);
      // The second message is still pending
      expect(batcher.getStats().pending_messages).toBe(1);

      await batcher.stop();
    });
  });
});
