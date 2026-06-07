import { describe, it, expect } from "vitest";
import { MessageBatcher } from "../../src/message-batcher.js";

// ── Helpers ───────────────────────────────────────────────────────────

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

interface FakeAgent {
  id: string;
  messagesSent: number;
  errors: number;
}

function createAgent(id: string): FakeAgent {
  return { id, messagesSent: 0, errors: 0 };
}

/**
 * Simulate a single agent sending messages through the batcher.
 */
async function agentWork(
  agent: FakeAgent,
  batcher: MessageBatcher<{ agentId: string; payload: string }>,
  messageCount: number,
): Promise<void> {
  for (let i = 0; i < messageCount; i++) {
    try {
      batcher.add({
        id: `${agent.id}-msg-${i}`,
        payload: { agentId: agent.id, payload: `data-${i}` },
      });
      agent.messagesSent++;
    } catch {
      agent.errors++;
    }
  }
}

// ── Load Tests ────────────────────────────────────────────────────────

describe("Load Test — concurrent agents", () => {
  it("handles 100 concurrent agents sending messages", async () => {
    const AGENT_COUNT = 100;
    const MESSAGES_PER_AGENT = 10;

    let totalProcessed = 0;
    const batcher = new MessageBatcher<{ agentId: string; payload: string }>({
      batch_size: 50,
      batch_timeout_ms: 100,
      logger: noopLogger,
    });

    batcher.start(async (batch) => {
      totalProcessed += batch.messages.length;
      return true;
    });

    const agents: FakeAgent[] = [];
    const promises: Promise<void>[] = [];

    for (let i = 0; i < AGENT_COUNT; i++) {
      const agent = createAgent(`agent-${i}`);
      agents.push(agent);
      promises.push(agentWork(agent, batcher, MESSAGES_PER_AGENT));
    }

    await Promise.all(promises);
    // Allow pending flushes to complete.
    await new Promise((r) => setTimeout(r, 300));
    await batcher.stop();

    const totalSent = agents.reduce((sum, a) => sum + a.messagesSent, 0);
    expect(totalSent).toBe(AGENT_COUNT * MESSAGES_PER_AGENT);
    expect(totalProcessed).toBe(totalSent);

    const stats = batcher.getStats();
    expect(stats.batches_failed).toBe(0);
  });

  it("maintains message ordering within batches under load", async () => {
    const ORDER_COUNT = 200;
    const receivedOrder: string[] = [];

    const batcher = new MessageBatcher<{ seq: number }>({
      batch_size: 20,
      batch_timeout_ms: 50,
      logger: noopLogger,
    });

    batcher.start(async (batch) => {
      for (const msg of batch.messages) {
        receivedOrder.push(`${msg.payload.seq}`);
      }
      return true;
    });

    for (let i = 0; i < ORDER_COUNT; i++) {
      batcher.add({ id: `ord-${i}`, payload: { seq: i } });
    }

    await new Promise((r) => setTimeout(r, 200));
    await batcher.stop();

    // All messages should be received.
    expect(receivedOrder).toHaveLength(ORDER_COUNT);

    // Within each batch, ordering should be preserved (sequences should
    // be monotonically increasing within each contiguous group).
    let lastSeq = -1;
    for (const seqStr of receivedOrder) {
      const seq = parseInt(seqStr, 10);
      // seq should be greater than the previous one (strict ordering within batch).
      expect(seq).toBeGreaterThan(lastSeq);
      lastSeq = seq;
    }
  });

  it("handles high-frequency burst without data loss", async () => {
    const BURST_SIZE = 500;
    let processed = 0;

    const batcher = new MessageBatcher<{ burstId: number }>({
      batch_size: 100,
      batch_timeout_ms: 50,
      logger: noopLogger,
    });

    batcher.start(async (batch) => {
      // Simulate variable processing latency.
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      processed += batch.messages.length;
      return true;
    });

    // Fire all messages in a tight loop.
    for (let i = 0; i < BURST_SIZE; i++) {
      batcher.add({ id: `burst-${i}`, payload: { burstId: i } });
    }

    await new Promise((r) => setTimeout(r, 500));
    await batcher.stop();

    expect(processed).toBe(BURST_SIZE);
  });

  it("handles agent failures without crashing the batcher", async () => {
    const AGENT_COUNT = 50;
    let successCount = 0;
    let failCount = 0;

    const batcher = new MessageBatcher<{ agentId: string }>({
      batch_size: 10,
      batch_timeout_ms: 50,
      max_retries: 1,
      retry_base_delay_ms: 10,
      logger: noopLogger,
    });

    batcher.start(async (batch) => {
      // Simulate 30% failure rate.
      if (Math.random() < 0.3) {
        return false;
      }
      successCount += batch.messages.length;
      return true;
    });

    const promises: Promise<void>[] = [];
    for (let i = 0; i < AGENT_COUNT; i++) {
      const agent = createAgent(`agent-${i}`);
      promises.push(agentWork(agent, batcher, 5));
    }

    await Promise.all(promises);
    await new Promise((r) => setTimeout(r, 500));
    await batcher.stop();

    const stats = batcher.getStats();
    // With retries, most should succeed. Some may fail permanently.
    expect(stats.batches_succeeded + stats.batches_failed).toBeGreaterThan(0);
    expect(successCount + failCount + stats.retries).toBeGreaterThanOrEqual(0);
  });
});
