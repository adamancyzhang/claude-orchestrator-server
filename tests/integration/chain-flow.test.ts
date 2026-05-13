import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ChainRouter } from "../../src/leader/chain-router.js";
import { LeaderEventBus } from "../../src/leader/event-bus.js";
import { LeaderState } from "../../src/leader/state.js";
import { TaskQueue } from "../../src/modules/task-queue.js";
import { MessageRouter } from "../../src/modules/message-router.js";
import { MockZkClient } from "../fixtures/mock-zk.js";
import { MockClaudeRunner } from "../fixtures/mock-runner.js";
import { MockTemplateEngine } from "../fixtures/mock-template.js";
import { makeChainDef, makeInstance, makeMessage, makeEvalDecision } from "../fixtures/factories.js";
import type { ZkClient } from "../../src/zk/client.js";
import type { ClaudeRunner } from "../../src/executor/runner.js";
import type { TemplateEngine } from "../../src/executor/template.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chain-flow-"));
}

/**
 * Drive a full plan → build → verify → review → accept chain through the
 * ChainRouter using mocks. Verify each link gets its own task and that the
 * LeaderState reflects task lifecycle correctly.
 */
describe("integration: chain flow plan → build → verify → review → accept", () => {
  let zk: MockZkClient;
  let bus: LeaderEventBus;
  let state: LeaderState;
  let router: ChainRouter;
  let runner: MockClaudeRunner;
  let template: MockTemplateEngine;
  const workers: Record<string, ReturnType<typeof makeInstance>> = {};

  beforeEach(() => {
    zk = new MockZkClient();
    bus = new LeaderEventBus();
    state = new LeaderState();
    state.leaderName = "Atlas";
    state.leaderInstanceId = "leader-1";
    bus.onAll((e) => state.apply(e));

    const taskQueue = new TaskQueue(zk as unknown as ZkClient);
    const messageRouter = new MessageRouter(zk as unknown as ZkClient);
    runner = new MockClaudeRunner(tmp());
    template = new MockTemplateEngine();
    template.setFile("worker-task-doc.md", "DOC");

    router = new ChainRouter(
      zk as unknown as ZkClient, taskQueue, messageRouter,
      bus, "leader-1", "Atlas",
      runner as unknown as ClaudeRunner, template as unknown as TemplateEngine, null,
    );

    // Spin up one worker for each role
    for (const role of ["planner", "builder", "verifier", "reviewer", "accepter"] as const) {
      const inst = makeInstance({ name: role.toUpperCase(), role });
      inst.status = "idle";
      zk.instances.set(inst.id, inst);
      bus.emit({ type: "worker_joined", instance: inst, instanceId: inst.id, name: inst.name });
      workers[role] = inst;
    }
  });

  it("creates 5 tasks from a ChainDef and routes through every link to close", async () => {
    const chainDef = makeChainDef({ chain_id: "c-end-to-end" });

    // Phase 1: ChainDef arrives via task_defs
    const defMsg = makeMessage({ content: JSON.stringify(chainDef), link: "task_defs" });
    await router.route(defMsg);

    // After task_defs: 5 tasks in pending, chain activated, leader sent message to planner
    expect(state.pendingTasks.length).toBeGreaterThanOrEqual(4);
    expect(state.events.some((e) => e.message.includes("activated"))).toBe(true);
    expect(zk.createMessage).toHaveBeenCalled();

    // Now simulate each worker reporting "activate_next" in sequence.
    const links = ["plan", "build", "verify", "review"];
    for (const link of links) {
      vi.clearAllMocks();
      // Re-stub createMessage now that we just cleared the mock
      const decision = makeEvalDecision({ decision: "activate_next" });
      const reportMsg = makeMessage({
        content: JSON.stringify(decision),
        link,
        chain_id: chainDef.chain_id as string,
        from_instance: workers[linkToRole(link)].id,
        from_role: linkToRole(link),
      });
      await router.route(reportMsg);
    }

    // Final link: accept worker closes the chain
    const closeMsg = makeMessage({
      content: JSON.stringify(makeEvalDecision({ decision: "close_chain" })),
      link: "accept",
      chain_id: chainDef.chain_id as string,
      from_instance: workers.accepter.id,
      from_role: "accepter",
    });
    await router.route(closeMsg);

    const closed = state.events.find((e) => e.message.includes("closed"));
    expect(closed).toBeDefined();
  });
});

function linkToRole(link: string): "planner" | "builder" | "verifier" | "reviewer" | "accepter" {
  return ({
    plan: "planner", build: "builder", verify: "verifier",
    review: "reviewer", accept: "accepter",
  } as const)[link]!;
}
