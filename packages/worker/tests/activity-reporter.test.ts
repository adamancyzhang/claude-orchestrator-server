// CORE-RETENTION
// Locks in: WorkerActivityReporter — Worker-side batching transport
// for pipeline-step events. Specifically:
// (a) report() buffers payloads; flush is triggered automatically by
//     timer (flush_ms) or batch size (max_batch), whichever comes first.
// (b) flush() sends a single message containing the entire batch in
//     JSON `content`, with `type: "worker_activity"` so the Leader
//     watcher can intercept and fan it out to N LeaderEvents.
// (c) send() rejections are absorbed via .catch() — the reporter is
//     observability-only and must NEVER take the watch loop down.
// (d) stop() cancels the pending timer and drops the buffer; further
//     report() calls are silently dropped.
// Critical because: this transport is the only bridge between the
// Worker's pipeline phases and the TUI. A regression that swallows
// payloads silently (no error surfaces) leaves the TUI dark.
// Primary sources: packages/worker/src/activity-reporter.ts

import { describe, expect, it, vi } from "vitest";
import {
  asInstanceId,
  type ILogger,
  type IMessageRouter,
  type SendMessageInput,
  type Message,
} from "@co/contracts";
import { WorkerActivityReporter } from "../src/activity-reporter.js";

const SELF = asInstanceId("worker-self");
const LEADER = asInstanceId("leader");

// CapturingLogger is a test data structure — captures warn calls so
// we can assert send-failure recovery.
class CapturingLogger implements ILogger {
  public readonly warns: { msg: string; meta?: Record<string, unknown> }[] = [];
  debug(): void {}
  info(): void {}
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.warns.push({ msg, meta });
  }
  error(): void {}
  child(): ILogger {
    return this;
  }
}

// CapturingRouter is a test data structure — records sends, optionally
// rejects to drive failure paths.
class CapturingRouter implements IMessageRouter {
  public readonly sent: SendMessageInput[] = [];
  private shouldReject = false;

  setReject(v: boolean): void {
    this.shouldReject = v;
  }

  async send(input: SendMessageInput): Promise<Message> {
    if (this.shouldReject) {
      throw new Error("router send failed");
    }
    this.sent.push(input);
    return {} as Message;
  }
  async poll(): Promise<Message[]> {
    return [];
  }
  async waitForMessage(): Promise<void> {
    throw new Error("not used");
  }
  async dismiss(): Promise<void> {
    throw new Error("not used");
  }
}

function newReporter(opts?: {
  flush_ms?: number;
  max_batch?: number;
  router?: CapturingRouter;
  logger?: CapturingLogger;
}): {
  reporter: WorkerActivityReporter;
  router: CapturingRouter;
  logger: CapturingLogger;
} {
  const router = opts?.router ?? new CapturingRouter();
  const logger = opts?.logger ?? new CapturingLogger();
  const reporter = new WorkerActivityReporter({
    router,
    identity: {
      instance_id: SELF,
      worker_name: "alice",
      worker_role: "executor",
      leader_id: LEADER,
    },
    logger,
    flush_ms: opts?.flush_ms ?? 200,
    max_batch: opts?.max_batch ?? 10,
    now: () => new Date("2026-05-25T01:02:03Z"),
  });
  return { reporter, router, logger };
}

describe("WorkerActivityReporter — batching", () => {
  it("buffers below max_batch and flushes nothing immediately", async () => {
    const { reporter, router } = newReporter({ max_batch: 5 });
    reporter.report({
      phase: "claim",
      action: "phase_start",
      detail: "task t-1",
      task_id: null,
    });
    expect(router.sent).toHaveLength(0);
  });

  it("auto-flushes when buffer hits max_batch", async () => {
    // TRUST-JUSTIFICATION: vi.useFakeTimers is the standard tool for
    // testing time-driven flush. The fake clock is local to this test;
    // setTimeout in the reporter is what we're verifying does NOT
    // prematurely fire when the size trigger fires first.
    vi.useFakeTimers();
    try {
      const { reporter, router } = newReporter({ max_batch: 3 });
      reporter.report({ phase: "claim", action: "phase_start", detail: "1" });
      reporter.report({ phase: "claim", action: "phase_end", detail: "2" });
      expect(router.sent).toHaveLength(0);
      reporter.report({ phase: "rebase", action: "phase_start", detail: "3" });
      // The 3rd report hit max_batch — flush is in-flight async.
      await vi.runAllTimersAsync();
      expect(router.sent).toHaveLength(1);
      const parsed = JSON.parse(router.sent[0].content) as {
        batch: { detail: string }[];
      };
      expect(parsed.batch).toHaveLength(3);
      expect(parsed.batch[0].detail).toBe("1");
      expect(parsed.batch[2].detail).toBe("3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-flushes after flush_ms when below max_batch", async () => {
    vi.useFakeTimers();
    try {
      const { reporter, router } = newReporter({ flush_ms: 100, max_batch: 999 });
      reporter.report({ phase: "claim", action: "phase_start", detail: "a" });
      expect(router.sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(101);
      expect(router.sent).toHaveLength(1);
      const parsed = JSON.parse(router.sent[0].content) as {
        batch: { detail: string }[];
      };
      expect(parsed.batch).toEqual([
        expect.objectContaining({ detail: "a", phase: "claim" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("explicit flush() drains buffer and clears the timer", async () => {
    vi.useFakeTimers();
    try {
      const { reporter, router } = newReporter({ flush_ms: 500, max_batch: 999 });
      reporter.report({ phase: "claim", action: "phase_start", detail: "x" });
      await reporter.flush();
      expect(router.sent).toHaveLength(1);
      // After explicit flush, the original timer should be cleared and
      // not fire a duplicate.
      await vi.advanceTimersByTimeAsync(1000);
      expect(router.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WorkerActivityReporter — wire format", () => {
  it("sends type=worker_activity with the batch in content JSON", async () => {
    const { reporter, router } = newReporter({ max_batch: 1 });
    reporter.report({
      phase: "commit",
      action: "phase_end",
      detail: "sha abcd1234",
      link: "execute",
    });
    await reporter.flush();
    const sent = router.sent[0];
    expect(sent.type).toBe("worker_activity");
    expect(sent.from_instance).toBe(SELF);
    expect(sent.to_instance).toBe(LEADER);
    expect(sent.link).toBe("execute");
    const parsed = JSON.parse(sent.content) as {
      batch: Array<{
        phase: string;
        action: string;
        detail: string;
        timestamp: string;
        link: string | null;
      }>;
    };
    expect(parsed.batch).toHaveLength(1);
    expect(parsed.batch[0]).toMatchObject({
      phase: "commit",
      action: "phase_end",
      detail: "sha abcd1234",
      link: "execute",
      timestamp: "2026-05-25T01:02:03.000Z",
    });
  });
});

describe("WorkerActivityReporter — failure isolation", () => {
  it("router send rejection is absorbed via logger.warn (does not throw)", async () => {
    const router = new CapturingRouter();
    router.setReject(true);
    const logger = new CapturingLogger();
    const { reporter } = newReporter({ router, logger });
    reporter.report({ phase: "claim", action: "phase_start", detail: "x" });
    // Must not throw — flush internally catches.
    await reporter.flush();
    expect(logger.warns.length).toBeGreaterThan(0);
    expect(logger.warns[0].msg).toContain("worker_activity send failed");
  });
});

describe("WorkerActivityReporter — stop()", () => {
  it("cancels pending timer and drops further reports", async () => {
    vi.useFakeTimers();
    try {
      const { reporter, router } = newReporter({ flush_ms: 100, max_batch: 999 });
      reporter.report({ phase: "claim", action: "phase_start", detail: "x" });
      reporter.stop();
      await vi.advanceTimersByTimeAsync(500);
      expect(router.sent).toHaveLength(0);
      reporter.report({ phase: "claim", action: "phase_end", detail: "y" });
      await reporter.flush();
      expect(router.sent).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
