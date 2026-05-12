import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ZkClient } from "../../src/zk/client.js";
import { InstanceRegistry } from "../../src/modules/registry.js";
import { MessageRouter } from "../../src/modules/message-router.js";
import type { Message } from "../../src/models/schemas.js";

const ZK_HOSTS = process.env.ZK_HOSTS || "127.0.0.1:2181";

function printSeparator(title: string): void {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(70)}`);
}

function printMessage(label: string, msg: Message): void {
  console.log(`\n  ── ${label} ──`);
  console.log(`    id:               ${msg.id}`);
  console.log(`    type:             ${msg.type}`);
  console.log(`    from_instance:    ${msg.from_instance}`);
  console.log(`    from_name:        ${msg.from_name}`);
  console.log(`    from_role:        ${msg.from_role || "(empty)"}`);
  console.log(`    to_instance:      ${msg.to_instance || "(null)"}`);
  console.log(`    to_name:          ${msg.to_name || "(null)"}`);
  console.log(`    content:          ${msg.content}`);
  console.log(`    created_at:       ${msg.created_at}`);
  console.log(`    read:             ${msg.read}`);
  console.log(`    link:             ${msg.link || "(null)"}`);
  console.log(`    task_title:       ${msg.task_title || "(null)"}`);
  console.log(`    task_description: ${msg.task_description || "(null)"}`);
  console.log(`    task_criteria:    ${msg.task_criteria || "(null)"}`);
  console.log(`    task_doc_path:    ${msg.task_doc_path || "(null)"}`);
  console.log(`    result_path:      ${msg.result_path || "(null)"}`);
  console.log(`    reply_to:         ${msg.reply_to || "(null)"}`);
}

function printMessages(label: string, msgs: Message[]): void {
  console.log(`\n  ── ${label} (${msgs.length} messages) ──`);
  msgs.forEach((msg, i) => printMessage(`Message #${i + 1}`, msg));
}

describe("Leader ↔ Worker Message Interactions", () => {
  let zk: ZkClient;
  let registry: InstanceRegistry;
  let router: MessageRouter;
  let leader: { id: string; name: string };
  let worker: { id: string; name: string };

  beforeAll(async () => {
    zk = new ZkClient(ZK_HOSTS);
    await zk.connect();
    registry = new InstanceRegistry(zk);
    router = new MessageRouter(zk);

    // Register leader and worker
    const leaderInst = await registry.register("TestLeader", "leader");
    leader = { id: leaderInst.id, name: leaderInst.name };
    console.log(`\n[Setup] Leader registered: id=${leader.id}, name=${leader.name}`);

    const workerInst = await registry.register("TestWorker", "builder");
    worker = { id: workerInst.id, name: workerInst.name };
    console.log(`[Setup] Worker registered:  id=${worker.id}, name=${worker.name}`);
  });

  afterAll(async () => {
    await zk.disconnect();
  });

  // ── Section 1: Direct Messages ──

  describe("1. Direct Messages (点对点消息)", () => {
    it("1.1 Leader → Worker: plain text message", async () => {
      printSeparator("1.1 Leader → Worker: plain text message");

      const msgs = await router.send(
        leader.id, leader.name,
        "Hello Worker! Please start working on the new feature.",
        worker.id,
      );

      printMessages("Sent", msgs);

      expect(msgs.length).toBe(1);
      expect(msgs[0].type).toBe("direct");
      expect(msgs[0].from_instance).toBe(leader.id);
      expect(msgs[0].from_name).toBe("TestLeader");
      expect(msgs[0].to_instance).toBe(worker.id);
      expect(msgs[0].content).toContain("Hello Worker");
    });

    it("1.2 Worker → Leader: reply message", async () => {
      printSeparator("1.2 Worker → Leader: reply message");

      const msgs = await router.send(
        worker.id, worker.name,
        "Got it! I'll start working right away. Expected completion in 2 hours.",
        leader.id,
      );

      printMessages("Sent", msgs);

      expect(msgs.length).toBe(1);
      expect(msgs[0].type).toBe("direct");
      expect(msgs[0].from_instance).toBe(worker.id);
      expect(msgs[0].from_name).toBe("TestWorker");
      expect(msgs[0].to_instance).toBe(leader.id);
    });

    it("1.3 Leader → Worker: task assignment with metadata", async () => {
      printSeparator("1.3 Leader → Worker: task assignment with metadata");

      // Use raw zk.createMessage to include extended fields
      const msg: Record<string, unknown> = {
        type: "direct",
        from_instance: leader.id,
        from_name: "TestLeader",
        from_role: "leader",
        to_instance: worker.id,
        to_name: "TestWorker",
        content: "Please implement the user login API endpoint.",
        created_at: new Date().toISOString(),
        read: false,
        link: "build",
        task_title: "Implement User Login API",
        task_description: "Create POST /api/auth/login endpoint with JWT token response.",
        task_criteria: "1. Accepts email/password JSON body\n2. Returns JWT access token\n3. 401 on invalid credentials\n4. Rate limiting: max 5 attempts per minute",
        task_doc_path: "/docs/specs/auth-api.md",
        reply_to: null,
        result_path: null,
      };
      const msgId = await zk.createMessage(worker.id, msg);
      msg.id = msgId;

      printMessage("Sent", msg as unknown as Message);

      expect(msgId).toBeTruthy();
      expect(msgId).toContain("msg-");
    });

    it("1.4 Worker: poll inbox (non-blocking)", async () => {
      printSeparator("1.4 Worker: poll inbox");

      const msgs = await router.poll(worker.id);
      printMessages("Worker's Inbox (poll)", msgs);

      expect(msgs.length).toBeGreaterThanOrEqual(2);
      // All messages should be marked read after poll
      msgs.forEach((m) => expect(m.read).toBe(true));
    });

    it("1.5 Leader: poll inbox", async () => {
      printSeparator("1.5 Leader: poll inbox");

      const msgs = await router.poll(leader.id);
      printMessages("Leader's Inbox (poll)", msgs);

      expect(msgs.length).toBeGreaterThanOrEqual(1);
    });

    it("1.6 Worker → Leader: progress report with task metadata", async () => {
      printSeparator("1.6 Worker → Leader: progress report");

      const progressMsg: Record<string, unknown> = {
        type: "direct",
        from_instance: worker.id,
        from_name: "TestWorker",
        from_role: "builder",
        to_instance: leader.id,
        to_name: "TestLeader",
        content: "Login API implementation is 60% complete. Database schema done, working on controller logic.",
        created_at: new Date().toISOString(),
        read: false,
        link: "build",
        task_title: "Implement User Login API",
        task_description: "Progress update at 60%",
        result_path: null,
        reply_to: null,
      };
      const msgId = await zk.createMessage(leader.id, progressMsg);
      progressMsg.id = msgId;

      printMessage("Sent", progressMsg as unknown as Message);

      expect(msgId).toBeTruthy();
    });
  });

  // ── Section 2: Name-based Addressing ──

  describe("2. Name-based Addressing (基于名称的寻址)", () => {
    it("2.1 Leader → @TestWorker (by name)", async () => {
      printSeparator("2.1 Leader → @TestWorker (by name)");

      const msgs = await router.send(
        leader.id, leader.name,
        "This message was addressed to @TestWorker by name, not by ID.",
        undefined, false, "TestWorker",
      );

      printMessages("Sent", msgs);

      expect(msgs.length).toBe(1);
      expect(msgs[0].to_instance).toBe(worker.id);
    });

    it("2.2 Worker → @TestLeader (by name)", async () => {
      printSeparator("2.2 Worker → @TestLeader (by name)");

      const msgs = await router.send(
        worker.id, worker.name,
        "Replying to @TestLeader by name — name-based addressing confirmed working.",
        undefined, false, "TestLeader",
      );

      printMessages("Sent", msgs);

      expect(msgs.length).toBe(1);
      expect(msgs[0].to_instance).toBe(leader.id);
    });
  });

  // ── Section 3: Broadcast Messages ──

  describe("3. Broadcast Messages (广播消息)", () => {
    it("3.1 Leader: broadcast announcement to all workers", async () => {
      printSeparator("3.1 Leader: broadcast announcement");

      // Register a second worker for broadcast testing
      const worker2 = await registry.register("TestWorker2", "verifier");
      console.log(`  [Setup] Second worker registered: id=${worker2.id}, name=${worker2.name}`);

      const msgs = await router.send(
        leader.id, leader.name,
        "ANNOUNCEMENT: All workers please sync to latest main branch. New API contracts published.",
        undefined, true,
      );

      printMessages("Broadcast Sent", msgs);

      expect(msgs.length).toBeGreaterThanOrEqual(2);
      msgs.forEach((m) => {
        expect(m.type).toBe("broadcast");
        expect(m.from_instance).toBe(leader.id);
      });

      // Check that workers received it
      const w1Inbox = await router.poll(worker.id);
      const broadcastToW1 = w1Inbox.filter((m) => m.type === "broadcast");
      console.log(`\n  Worker1 received ${broadcastToW1.length} broadcast message(s)`);

      const w2Inbox = await router.poll(worker2.id);
      const broadcastToW2 = w2Inbox.filter((m) => m.type === "broadcast");
      console.log(`  Worker2 received ${broadcastToW2.length} broadcast message(s)`);
    });

    it("3.2 Worker: broadcast to all (including leader)", async () => {
      printSeparator("3.2 Worker: broadcast to all");

      const msgs = await router.send(
        worker.id, worker.name,
        "Question for everyone: Has anyone seen this bug? TypeError: Cannot read properties of undefined (reading 'map') in task-123.",
        undefined, true,
      );

      printMessages("Broadcast Sent", msgs);

      expect(msgs.length).toBeGreaterThanOrEqual(2);
      msgs.forEach((m) => expect(m.from_instance).toBe(worker.id));
    });
  });

  // ── Section 4: Help Messages ──

  describe("4. Help Messages (求助消息)", () => {
    it("4.1 Worker: request help from everyone", async () => {
      printSeparator("4.1 Worker: request help");

      const msgs = await router.send(
        worker.id, worker.name,
        "HELP: I'm blocked on setting up the database migration. Getting 'relation already exists' error.",
        undefined, false, undefined, true, // help=true
      );

      printMessages("Help Request Sent", msgs);

      expect(msgs.length).toBeGreaterThanOrEqual(2);
      msgs.forEach((m) => expect(m.type).toBe("help"));
    });
  });

  // ── Section 5: wait_for_message ──

  describe("5. wait_for_message (长轮询)", () => {
    // Helper: dismiss ALL messages so inbox is truly empty.
    // poll() only marks messages read but doesn't remove them,
    // and waitForMessage returns immediately if ANY messages exist (read or unread).
    async function clearInbox(instanceId: string): Promise<void> {
      const msgs = await router.poll(instanceId);
      for (const msg of msgs) {
        await router.dismissMessage(instanceId, msg.id);
      }
    }

    it("5.1 wait_for_message: returns existing messages immediately", async () => {
      printSeparator("5.1 wait_for_message: existing messages");

      // Clear all existing messages for a clean starting point
      await clearInbox(worker.id);

      // Send a message, then wait — it should return immediately
      await router.send(leader.id, leader.name, "Pre-sent message for wait_for_message test.", worker.id);

      const msgs = await router.waitForMessage(worker.id, 5);
      printMessages("Received via wait_for_message", msgs);

      expect(msgs.length).toBe(1);
    });

    it("5.2 wait_for_message: long-poll for new message", async () => {
      printSeparator("5.2 wait_for_message: long-poll");

      // Clear inbox for a truly empty state
      await clearInbox(worker.id);

      // Start long-poll (will block on watch since inbox is empty)
      const waitPromise = router.waitForMessage(worker.id, 10);

      // Send after 300ms — the ZK watch should fire and resolve the wait
      await new Promise((r) => setTimeout(r, 300));
      await router.send(leader.id, leader.name, "Delayed message sent after 300ms — long-poll should catch it!", worker.id);

      const msgs = await waitPromise;
      printMessages("Long-poll result", msgs);

      expect(msgs.length).toBe(1);
    }, 15000);

    it("5.3 wait_for_message: timeout returns empty array", async () => {
      printSeparator("5.3 wait_for_message: timeout");

      // Clear inbox for a truly empty state
      await clearInbox(worker.id);

      const start = Date.now();
      const msgs = await router.waitForMessage(worker.id, 2);
      const elapsed = Date.now() - start;

      console.log(`  Elapsed: ${elapsed}ms`);
      console.log(`  Messages returned: ${msgs.length}`);
      printMessages("Timeout result", msgs);

      expect(msgs).toEqual([]);
      expect(elapsed).toBeGreaterThanOrEqual(1900);
    }, 10000);
  });

  // ── Section 6: mark_read & dismiss_message ──

  describe("6. mark_read & dismiss_message (标记已读 & 删除)", () => {
    it("6.1 mark_read on specific message", async () => {
      printSeparator("6.1 mark_read");

      // Send a message, then mark it read
      const sent = await router.send(leader.id, leader.name, "Message to be marked read.", worker.id);
      const msgId = sent[0].id;
      console.log(`  Message ID: ${msgId}`);

      // Get raw data before mark_read
      const before = await zk.getMessage(worker.id, msgId);
      console.log(`  Before mark_read — read: ${before?.read}`);

      await router.markRead(worker.id, msgId);

      const after = await zk.getMessage(worker.id, msgId);
      console.log(`  After mark_read  — read: ${after?.read}`);

      expect(after?.read).toBe(true);
    });

    it("6.2 dismiss_message: delete from inbox", async () => {
      printSeparator("6.2 dismiss_message");

      const sent = await router.send(leader.id, leader.name, "Message that will be dismissed.", worker.id);
      const msgId = sent[0].id;
      console.log(`  Message ID: ${msgId}`);

      const before = await zk.getMessage(worker.id, msgId);
      console.log(`  Before dismiss — exists: ${before !== null}`);

      await router.dismissMessage(worker.id, msgId);

      const after = await zk.getMessage(worker.id, msgId);
      console.log(`  After dismiss  — exists: ${after !== null}`);

      expect(before).not.toBeNull();
      expect(after).toBeNull();
    });
  });

  // ── Section 7: Complete Interaction Scenario ──

  describe("7. Complete Interaction Scenario (完整交互场景)", () => {
    it("7.1 Simulated: Leader assigns task → Worker reports progress → Worker requests help → Leader responds", async () => {
      printSeparator("7. Complete Scenario: Multi-turn conversation");

      // Round 1: Leader assigns task
      console.log("\n  ─── Round 1: Leader assigns task ───");
      const assign = await router.send(
        leader.id, leader.name,
        "Task #42: Please implement the payment integration module.",
        worker.id,
      );
      printMessage("Leader → Worker", assign[0]);

      // Round 2: Worker acknowledges
      console.log("\n  ─── Round 2: Worker acknowledges ───");
      const ack = await router.send(
        worker.id, worker.name,
        "Acknowledged. I'll start with the Stripe API integration first.",
        leader.id,
      );
      printMessage("Worker → Leader", ack[0]);

      // Round 3: Worker reports progress
      console.log("\n  ─── Round 3: Worker reports 50% progress ───");
      const progress: Record<string, unknown> = {
        type: "direct",
        from_instance: worker.id,
        from_name: "TestWorker",
        from_role: "builder",
        to_instance: leader.id,
        to_name: "TestLeader",
        content: "Progress update: Stripe API wrapper done. Now working on webhook handler and refund flow.",
        created_at: new Date().toISOString(),
        read: false,
        link: "build",
        task_title: "Payment Integration Module",
        task_description: "Stripe integration with webhook handling and refund support",
        result_path: "/workdir/payment-module/",
        reply_to: assign[0].id,
      };
      const progressId = await zk.createMessage(leader.id, progress);
      progress.id = progressId;
      printMessage("Worker → Leader (progress)", progress as unknown as Message);

      // Round 4: Worker hits a blocker, requests help
      console.log("\n  ─── Round 4: Worker requests help ───");
      const help: Record<string, unknown> = {
        type: "help",
        from_instance: worker.id,
        from_name: "TestWorker",
        from_role: "builder",
        to_instance: leader.id,
        to_name: "TestLeader",
        content: "HELP: Stripe webhook signature verification failing. Getting 'No signatures found matching expected signature' error. Using the raw body parser middleware but still failing.",
        created_at: new Date().toISOString(),
        read: false,
        link: "build",
        task_title: "Payment Integration Module",
        task_description: "Webhook signature verification issue",
        task_criteria: "Must verify Stripe-Signature header against raw body",
        reply_to: progressId,
      };
      const helpId = await zk.createMessage(leader.id, help);
      help.id = helpId;
      printMessage("Worker → Leader (help)", help as unknown as Message);

      // Round 5: Leader responds with guidance
      console.log("\n  ─── Round 5: Leader responds with guidance ───");
      const response: Record<string, unknown> = {
        type: "direct",
        from_instance: leader.id,
        from_name: "TestLeader",
        from_role: "leader",
        to_instance: worker.id,
        to_name: "TestWorker",
        content: "The issue is likely middleware ordering. Make sure express.raw() is applied to the webhook route BEFORE express.json() on other routes. Also check that you're using the raw body buffer, not the parsed JSON.",
        created_at: new Date().toISOString(),
        read: false,
        link: null,
        reply_to: helpId,
      };
      const responseId = await zk.createMessage(worker.id, response);
      response.id = responseId;
      printMessage("Leader → Worker (response)", response as unknown as Message);

      // Round 6: Worker confirms fix
      console.log("\n  ─── Round 6: Worker confirms the fix worked ───");
      const confirm = await router.send(
        worker.id, worker.name,
        "That fixed it! The middleware ordering was the issue. Webhook verification now passing. Continuing with refund flow.",
        leader.id,
      );
      printMessage("Worker → Leader (confirmation)", confirm[0]);

      // Verify the full conversation
      console.log("\n  ─── Full Inbox Summary ───");

      const leaderInbox = await router.poll(leader.id);
      const workerInbox = await router.poll(worker.id);

      console.log(`\n  Leader (${leader.name}) inbox: ${leaderInbox.length} messages total`);
      leaderInbox.forEach((m) => {
        console.log(`    [${m.type}] ${m.from_name} → ${m.to_name || "?"}: ${m.content.substring(0, 80)}...`);
      });

      console.log(`\n  Worker (${worker.name}) inbox: ${workerInbox.length} messages total`);
      workerInbox.forEach((m) => {
        console.log(`    [${m.type}] ${m.from_name} → ${m.to_name || "?"}: ${m.content.substring(0, 80)}...`);
      });

      expect(leaderInbox.length).toBeGreaterThanOrEqual(3);
      expect(workerInbox.length).toBeGreaterThanOrEqual(3);
    });
  });
});
