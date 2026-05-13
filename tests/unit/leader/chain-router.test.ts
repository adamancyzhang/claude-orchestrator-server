import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ChainRouter } from "../../../src/leader/chain-router.js";
import { LeaderEventBus } from "../../../src/leader/event-bus.js";
import { TaskQueue } from "../../../src/modules/task-queue.js";
import { MessageRouter } from "../../../src/modules/message-router.js";
import { MockZkClient } from "../../fixtures/mock-zk.js";
import { MockClaudeRunner } from "../../fixtures/mock-runner.js";
import { MockTemplateEngine } from "../../fixtures/mock-template.js";
import { makeChainDef, makeEvalDecision, makeInstance, makeMessage } from "../../fixtures/factories.js";
import { captureEvents } from "../../fixtures/helpers.js";
import type { ZkClient } from "../../../src/zk/client.js";
import type { ClaudeRunner } from "../../../src/executor/runner.js";
import type { TemplateEngine } from "../../../src/executor/template.js";

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-router-"));
  return dir;
}

describe("ChainRouter.route", () => {
  let zk: MockZkClient;
  let bus: LeaderEventBus;
  let taskQueue: TaskQueue;
  let messageRouter: MessageRouter;
  let runner: MockClaudeRunner;
  let template: MockTemplateEngine;
  let router: ChainRouter;
  let events: ReturnType<typeof captureEvents>;

  beforeEach(() => {
    zk = new MockZkClient();
    bus = new LeaderEventBus();
    events = captureEvents(bus);
    taskQueue = new TaskQueue(zk as unknown as ZkClient);
    messageRouter = new MessageRouter(zk as unknown as ZkClient);
    runner = new MockClaudeRunner(tmpDir());
    template = new MockTemplateEngine();
    template.setFile("worker-task-doc.md", "DOC: {{title}} ({{link}})");

    router = new ChainRouter(
      zk as unknown as ZkClient,
      taskQueue,
      messageRouter,
      bus,
      "leader-1",
      "Leader",
      runner as unknown as ClaudeRunner,
      template as unknown as TemplateEngine,
      null,
    );
  });

  it("no-link + no decompose template falls back to forwarding to planner", async () => {
    // No decompose template loaded → forwardToPlanner
    const planner = makeInstance({ name: "Planny", role: "planner" });
    planner.status = "idle";
    zk.instances.set(planner.id, planner);

    const msg = makeMessage({ content: "build a thing", link: null });
    await router.route(msg);

    expect(zk.createMessage).toHaveBeenCalledTimes(1);
    const [targetId, payload] = zk.createMessage.mock.calls[0];
    expect(targetId).toBe(planner.id);
    expect((payload as { link: string }).link).toBe("decompose");
    expect((payload as { content: string }).content).toBe("build a thing");
  });

  it("no-link + decompose template available → self-processes via runner", async () => {
    template.setTemplate("decompose", "DECOMPOSE PROMPT");
    const chainDef = makeChainDef({ chain_id: "c-1" });

    // The runner reads from the resultPath after run(); fake that file.
    runner.run = vi.fn(async (_prompt: string, _logPath: string) => {
      const resultPath = runner.resultPath.mock.results.at(-1)?.value as string;
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(resultPath, JSON.stringify(chainDef));
      return { code: 0, sessionId: "s" };
    });

    const msg = makeMessage({ content: "build a thing", link: null });
    await router.route(msg);

    // chain_activated must fire after 5 tasks are created
    const activated = events.find((e) => e.type === "chain_activated");
    expect(activated).toBeDefined();
    expect("chainId" in activated! && activated.chainId).toBe("c-1");

    const created = events.filter((e) => e.type === "task_created");
    expect(created.length).toBe(5);
  });

  it("link=task_defs parses ChainDef and creates 5 tasks", async () => {
    const chainDef = makeChainDef({ chain_id: "c-2" });
    const msg = makeMessage({ content: JSON.stringify(chainDef), link: "task_defs" });
    await router.route(msg);

    const created = events.filter((e) => e.type === "task_created");
    expect(created.length).toBe(5);
    const activated = events.find((e) => e.type === "chain_activated");
    expect(activated).toBeDefined();
  });

  it("activate_next routes to NEXT_LINKS for the current link", async () => {
    const builder = makeInstance({ name: "Builder", role: "builder" });
    builder.status = "idle";
    zk.instances.set(builder.id, builder);

    const decision = makeEvalDecision({ decision: "activate_next" });
    const msg = makeMessage({
      content: JSON.stringify(decision),
      link: "plan",
      chain_id: "c-x",
    });
    await router.route(msg);

    // A new task for "build" should be created
    const created = events.filter((e) => e.type === "task_created");
    expect(created).toHaveLength(1);

    // Message sent to the builder
    const sentToBuilder = zk.createMessage.mock.calls.find(
      ([target]) => target === builder.id,
    );
    expect(sentToBuilder).toBeDefined();
    expect((sentToBuilder![1] as { link: string }).link).toBe("build");
  });

  it("close_chain emits chain_closed with the message's chain_id", async () => {
    const decision = makeEvalDecision({ decision: "close_chain" });
    const msg = makeMessage({
      content: JSON.stringify(decision),
      link: "accept",
      chain_id: "c-closing",
    });
    await router.route(msg);

    const closed = events.find((e) => e.type === "chain_closed");
    expect(closed).toBeDefined();
    expect("chainId" in closed! && closed.chainId).toBe("c-closing");
  });

  it("feedback decision sends a message back to the worker", async () => {
    const builder = makeInstance({ name: "Builder", role: "builder" });
    builder.status = "idle";
    zk.instances.set(builder.id, builder);

    const decision = makeEvalDecision({
      decision: "feedback",
      feedback: "Please clarify the spec",
    });
    const msg = makeMessage({
      content: JSON.stringify(decision),
      link: "verify",
      chain_id: "c-fb",
      from_instance: builder.id,
    });
    await router.route(msg);

    // No new task_created; feedback only sends a message
    const created = events.filter((e) => e.type === "task_created");
    expect(created).toHaveLength(0);
    // A message was sent to builder.id
    const fwd = zk.createMessage.mock.calls.find(([tid]) => tid === builder.id);
    expect(fwd).toBeDefined();
    expect((fwd![1] as { content: string }).content).toBe("Please clarify the spec");
  });
});
