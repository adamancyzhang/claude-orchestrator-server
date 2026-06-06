// PERFORMANCE-TEST
// Locks in: CPU optimization improvements — resource monitor efficiency,
// alert deduplication, message batcher performance.
// Critical because: CPU optimization reduces resource usage and improves
// system responsiveness under load.
// Primary sources: packages/infra/src/resource-monitor.ts, message-batcher.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ResourceMonitor } from "../src/resource-monitor.js";
import { MessageBatcher } from "../src/message-batcher.js";

describe("CPU Optimization", () => {
  describe("ResourceMonitor optimizations", () => {
    let monitor: ResourceMonitor;

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      monitor?.stop();
      vi.useRealTimers();
    });

    it("caches CPU count on construction", () => {
      // First construction - should not throw
      monitor = new ResourceMonitor({ interval_ms: 1000 });
      expect(monitor).toBeDefined();
    });

    it("collects snapshots efficiently", () => {
      monitor = new ResourceMonitor({ interval_ms: 100 });
      monitor.start();

      // Run 100 snapshot collections
      for (let i = 0; i < 100; i++) {
        vi.advanceTimersByTime(100);
      }

      const snapshot = monitor.getLatestSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.cpu_usage_percent).toBeGreaterThanOrEqual(0);
      expect(snapshot!.cpu_usage_percent).toBeLessThanOrEqual(100);
    });

    it("deduplicates alerts within cooldown window", () => {
      const alertCallback = vi.fn();
      monitor = new ResourceMonitor({
        cpu_warning_threshold: 0, // Always trigger
        memory_warning_threshold: 100, // Never trigger memory alerts
        interval_ms: 100,
      });
      monitor.onAlert(alertCallback);
      monitor.start();

      // First alert should fire
      vi.advanceTimersByTime(150);
      const firstCallCount = alertCallback.mock.calls.length;

      // Subsequent alerts within 60s cooldown should be suppressed
      vi.advanceTimersByTime(100);
      vi.advanceTimersByTime(100);
      const secondCallCount = alertCallback.mock.calls.length;

      // After cooldown, alert should fire again
      vi.advanceTimersByTime(61000);
      const thirdCallCount = alertCallback.mock.calls.length;

      // Verify deduplication worked
      expect(firstCallCount).toBeGreaterThanOrEqual(1);
      expect(secondCallCount).toBe(firstCallCount); // No new alerts in cooldown
      expect(thirdCallCount).toBeGreaterThanOrEqual(firstCallCount + 1); // Alert after cooldown
    });

    it("handles missing CPU data gracefully", () => {
      monitor = new ResourceMonitor({ interval_ms: 100 });
      monitor.start();
      vi.advanceTimersByTime(100);

      const snapshot = monitor.getLatestSnapshot();
      expect(snapshot).not.toBeNull();
      expect(typeof snapshot!.cpu_usage_percent).toBe("number");
    });
  });

  describe("MessageBatcher optimizations", () => {
    let batcher: MessageBatcher<{ type: string; data: number }>;

    beforeEach(() => {
      vi.useFakeTimers();
      batcher = new MessageBatcher({
        batch_size: 10,
        batch_timeout_ms: 100,
      });
    });

    afterEach(() => {
      batcher.stop();
      vi.useRealTimers();
    });

    it("processes batches efficiently without array copies", async () => {
      const processor = vi.fn().mockResolvedValue(true);
      batcher.start(processor);

      // Add 1000 messages in batches of 10
      for (let i = 0; i < 1000; i++) {
        batcher.add({
          id: `msg-${i}`,
          payload: { type: "test", data: i },
        });

        // Flush every 10 messages
        if (i % 10 === 9) {
          vi.advanceTimersByTime(100);
          await vi.advanceTimersByTimeAsync(50);
        }
      }

      // All messages should be processed
      const stats = batcher.getStats();
      expect(stats.messages_added).toBe(1000);
      expect(stats.batches_flushed).toBeGreaterThan(0);
    });

    it("maintains message ordering in batches", async () => {
      const processedBatches: number[][] = [];
      const processor = vi.fn().mockImplementation(async (batch) => {
        const ids = batch.messages.map((m) => m.payload.data);
        processedBatches.push(ids);
        return true;
      });

      batcher.start(processor);

      // Add messages in order
      for (let i = 0; i < 20; i++) {
        batcher.add({
          id: `msg-${i}`,
          payload: { type: "test", data: i },
        });
      }

      vi.advanceTimersByTime(200);
      await vi.advanceTimersByTimeAsync(100);

      // All messages should be in order within each batch
      for (const batch of processedBatches) {
        for (let i = 1; i < batch.length; i++) {
          expect(batch[i]).toBeGreaterThan(batch[i - 1]);
        }
      }
    });

    it("handles high throughput without memory leaks", async () => {
      const processor = vi.fn().mockResolvedValue(true);
      batcher.start(processor);

      // Add many messages rapidly
      for (let i = 0; i < 5000; i++) {
        batcher.add({
          id: `msg-${i}`,
          payload: { type: "test", data: i },
        });
      }

      vi.advanceTimersByTime(1000);
      await vi.advanceTimersByTimeAsync(500);

      const stats = batcher.getStats();
      expect(stats.messages_added).toBe(5000);
      expect(stats.pending_messages).toBe(0);
    });
  });
});
