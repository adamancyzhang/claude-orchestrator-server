import { InstanceRegistry } from "../../dist/modules/registry.js";
import { TaskQueue } from "../../dist/modules/task-queue.js";
import { MessageRouter } from "../../dist/modules/message-router.js";

/**
 * Simulates a worker without calling Claude CLI.
 * Uses real ZK operations for register/claim/complete/send/poll.
 * Work is simulated with a brief setTimeout.
 */
export class MockWorker {
  constructor(zk, name, role, { createNextInChain } = {}) {
    this.zk = zk;
    this.name = name;
    this.role = role;
    this.registry = new InstanceRegistry(zk);
    this.taskQueue = new TaskQueue(zk);
    this.messageRouter = new MessageRouter(zk);
    this.instanceId = null;
    this.stopped = false;
    this.createNextInChain = createNextInChain || null;
  }

  async register() {
    const instance = await this.registry.register(
      this.name,
      this.role,
      this.instanceId
    );
    this.instanceId = instance.id;
    return instance;
  }

  async unregister() {
    if (this.instanceId) {
      await this.registry.unregister(this.instanceId);
    }
  }

  /** Claim one task, simulate work, complete it, optionally push next chain task */
  async doOneWorkCycle() {
    const task = await this.taskQueue.claim(this.instanceId);
    if (!task) return null;

    // Simulate work (no Claude CLI call)
    await new Promise((r) => setTimeout(r, 50));

    const result = `Completed by ${this.name} (${this.role}): ${task.title}`;
    const completed = await this.taskQueue.complete(
      this.instanceId,
      task.id,
      result
    );

    let nextTask = null;
    if (this.createNextInChain) {
      const params = this.createNextInChain(completed);
      if (params) {
        nextTask = await this.taskQueue.push(
          params.title,
          params.description || "",
          params.priority ?? 1,
          this.instanceId,
          params.assignee ?? undefined,
          undefined,
          undefined,
          params.link ?? undefined,
          params.chainId ?? undefined
        );
      }
    }

    return { completed, nextTask };
  }

  /**
   * Keep claiming and completing tasks until none available or maxIterations.
   * Returns array of results (each { completed, nextTask }).
   */
  async workLoop({ maxIterations = 10, pollIntervalMs = 200 } = {}) {
    const results = [];
    for (let i = 0; i < maxIterations && !this.stopped; i++) {
      const result = await this.doOneWorkCycle();
      if (result) {
        results.push(result);
      } else {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    }
    return results;
  }

  stop() {
    this.stopped = true;
  }

  async sendMessage(toInstanceId, content) {
    return this.messageRouter.send(
      this.instanceId,
      this.name,
      content,
      toInstanceId
    );
  }

  async broadcastMessage(content) {
    return this.messageRouter.send(
      this.instanceId,
      this.name,
      content,
      null,
      true
    );
  }

  async pollMessages() {
    return this.messageRouter.poll(this.instanceId);
  }
}
