import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BatchedMessageRouter } from "../src/batched-message-router.js";
import type { IMessageRouter, Message, SendMessageInput } from "@co/contracts";

describe("BatchedMessageRouter", () => {
  let mockRouter: IMessageRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    mockRouter = {
      send: vi.fn().mockResolvedValue({
        id: "msg-1",
        type: "direct",
        from_instance: "leader-1" as any,
        from_name: "Leader",
        to_instance: "worker-1" as any,
        content: "test",
        read: false,
        created_at: new Date().toISOString(),
      } as Message),
      poll: vi.fn().mockResolvedValue([]),
      waitForMessage: vi.fn(),
      ack: vi.fn(),
      dismiss: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic functionality", () => {
    it("should create a batched router with default options", () => {
      const router = new BatchedMessageRouter({ router: mockRouter });
      const stats = router.getStats();

      expect(stats.running).toBe(false);
      expect(router.getRouter()).toBe(mockRouter);
    });

    it("should start and stop the router", async () => {
      const router = new BatchedMessageRouter({ router: mockRouter });
      const processor = vi.fn().mockResolvedValue(true);

      router.start();
      expect(router.getStats().running).toBe(true);

      await router.stop();
      expect(router.getStats().running).toBe(false);
    });

    it("should throw when starting already running router", () => {
      const router = new BatchedMessageRouter({ router: mockRouter });
      router.start();

      expect(() => router.start()).toThrow("already running");
    });
  });

  describe("message batching", () => {
    it("should batch messages and send them together", async () => {
      const router = new BatchedMessageRouter({
        router: mockRouter,
        batch_size: 3,
      });

      router.start();

      const input1: SendMessageInput = {
        type: "direct",
        from_instance: "leader-1" as any,
        from_name: "Leader",
        to_instance: "worker-1" as any,
        content: "msg1",
      };

      const input2: SendMessageInput = {
        type: "direct",
        from_instance: "leader-1" as any,
        from_name: "Leader",
        to_instance: "worker-1" as any,
        content: "msg2",
      };

      const input3: SendMessageInput = {
        type: "direct",
        from_instance: "leader-1" as any,
        from_name: "Leader",
        to_instance: "worker-1" as any,
        content: "msg3",
      };

      router.send(input1);
      router.send(input2);
      router.send(input3);

      // Wait for batch to be processed
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRouter.send).toHaveBeenCalledTimes(3);
      expect(router.getStats().batches_succeeded).toBe(1);

      await router.stop();
    });

    it("should preserve message ordering", async () => {
      const router = new BatchedMessageRouter({
        router: mockRouter,
        batch_size: 5,
      });

      router.start();

      const inputs: SendMessageInput[] = [];
      for (let i = 0; i < 5; i++) {
        const input: SendMessageInput = {
          type: "direct",
          from_instance: "leader-1" as any,
          from_name: "Leader",
          to_instance: "worker-1" as any,
          content: `msg${i}`,
        };
        inputs.push(input);
        router.send(input);
      }

      await vi.advanceTimersByTimeAsync(0);

      // Verify messages were sent in order
      for (let i = 0; i < 5; i++) {
        expect(mockRouter.send).toHaveBeenNthCalledWith(i + 1, inputs[i]);
      }

      await router.stop();
    });

    it("should flush on timeout even if batch is not full", async () => {
      const router = new BatchedMessageRouter({
        router: mockRouter,
        batch_size: 10,
        batch_timeout_ms: 1000,
      });

      router.start();

      const input: SendMessageInput = {
        type: "direct",
        from_instance: "leader-1" as any,
        from_name: "Leader",
        to_instance: "worker-1" as any,
        content: "msg1",
      };

      router.send(input);

      expect(mockRouter.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockRouter.send).toHaveBeenCalledTimes(1);

      await router.stop();
    });
  });

  describe("error handling", () => {
    it("should retry failed batch processing", async () => {
      const router = new BatchedMessageRouter({
        router: mockRouter,
        batch_size: 1,
        max_retries: 2,
        retry_base_delay_ms_ms: 10,
      });

      (mockRouter.send as any)
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockResolvedValueOnce({ id: "msg-1", content: "ok" } as Message);

      router.start();

      const input: SendMessageInput = {
        type: "direct",
        from_instance: "leader-1" as any,
        from_name: "Leader",
        to_instance: "worker-1" as any,
        content: "msg1",
      };

      router.send(input);

      // Wait for retries
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);

      expect(mockRouter.send).toHaveBeenCalledTimes(3);
      expect(router.getStats().retries).toBe(2);
      expect(router.getStats().batches_succeeded).toBe(1);

      await router.stop();
    });

    it("should fail after max retries", async () => {
      const router = new BatchedMessageRouter({
        router: mockRouter,
        batch_size: 1,
        max_retries: 1,
        retry_base_delay_ms_ms: 10,
      });

      (mockRouter.send as any).mockRejectedValue(new Error("persistent failure"));

      router.start();

      const input: SendMessageInput = {
        type: "direct",
        from_instance: "leader-1" as any,
        from_name: "Leader",
        to_instance: "worker-1" as any,
        content: "msg1",
      };

      router.send(input);

      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);

      expect(mockRouter.send).toHaveBeenCalledTimes(2);
      expect(router.getStats().batches_failed).toBe(1);

      await router.stop();
    });

    it("should throw when sending to null instance", async () => {
      const router = new BatchedMessageRouter({ router: mockRouter });
      router.start();

      const input: SendMessageInput = {
        type: "direct",
        from_instance: "leader-1" as any,
        from_name: "Leader",
        to_instance: null,
        content: "msg1",
      };

      expect(() => router.send(input)).toThrow("requires to_instance");

      await router.stop();
    });
  });

  describe("statistics", () => {
    it("should track messages and batches", async () => {
      const router = new BatchedMessageRouter({
        router: mockRouter,
        batch_size: 2,
      });

      router.start();

      const input1: SendMessageInput = {
        type: "direct",
        from_instance: "leader-1" as any,
        from_name: "Leader",
        to_instance: "worker-1" as any,
        content: "msg1",
      };

      const input2: SendMessageInput = {
        type: "direct",
        from_instance: "leader-1" as any,
        from_name: "Leader",
        to_instance: "worker-1" as any,
        content: "msg2",
      };

      router.send(input1);
      router.send(input2);

      await vi.advanceTimersByTimeAsync(0);

      const stats = router.getStats();
      expect(stats.messages_added).toBe(2);
      expect(stats.batches_flushed).toBe(1);
      expect(stats.batches_succeeded).toBe(1);
      expect(stats.pending_messages).toBe(0);

      await router.stop();
    });
  });

  describe("flush on stop", () => {
    it("should flush remaining messages on stop", async () => {
      const router = new BatchedMessageRouter({
        router: mockRouter,
        batch_size: 5,
      });

      router.start();

      const input: SendMessageInput = {
        type: "direct",
        from_instance: "leader-1" as any,
        from_name: "Leader",
        to_instance: "worker-1" as any,
        content: "msg1",
      };

      router.send(input);

      expect(mockRouter.send).not.toHaveBeenCalled();

      await router.stop();

      expect(mockRouter.send).toHaveBeenCalledTimes(1);
    });

    it("should not flush if no messages", async () => {
      const router = new BatchedMessageRouter({ router: mockRouter });

      router.start();
      await router.stop();

      expect(mockRouter.send).not.toHaveBeenCalled();
    });
  });
});
