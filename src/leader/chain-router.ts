import * as path from "node:path";
import * as fs from "node:fs";
import { ZkClient } from "../zk/client.js";
import { TaskQueue } from "../modules/task-queue.js";
import { MessageRouter } from "../modules/message-router.js";
import { LeaderEventBus } from "./event-bus.js";
import {
  MessageSchema,
  createMessage,
  ChainDefSchema,
  EvalDecisionSchema,
  type Message,
  type EvalDecision,
} from "../models/schemas.js";

const NEXT_LINKS: Record<string, string | null> = {
  plan: "build",
  build: "verify",
  verify: "review",
  review: "accept",
  accept: null,
};

export class ChainRouter {
  constructor(
    private zk: ZkClient,
    private taskQueue: TaskQueue,
    private messageRouter: MessageRouter,
    private eventBus: LeaderEventBus,
    private leaderInstanceId: string,
    private leaderName: string,
    private cacheDir: string,
  ) {}

  async route(msg: Message): Promise<void> {
    const link = msg.link;
    if (!link) {
      return this.handleRequirement(msg);
    }
    if (link === "task_defs") {
      return this.handleTaskDefinitions(msg);
    }
    return this.handleCompletionReport(msg);
  }

  private async handleRequirement(msg: Message): Promise<void> {
    const planner = await this.findWorkerByRole("planner");
    if (!planner) {
      console.error("[ChainRouter] No planner worker available. Requirement not processed.");
      return;
    }

    const fwd = createMessage({
      from_instance: this.leaderInstanceId,
      from_name: this.leaderName,
      from_role: "leader",
      to_instance: planner.id,
      content: msg.content,
      link: "decompose",
      task_description: msg.content,
    });

    await this.zk.createMessage(planner.id, fwd as unknown as Record<string, unknown>);
    console.log(`[ChainRouter] Forwarded requirement to planner ${planner.name} (${planner.id.slice(0, 8)})`);
  }

  private async handleTaskDefinitions(msg: Message): Promise<void> {
    let chainDef;
    try {
      chainDef = ChainDefSchema.parse(JSON.parse(msg.content));
    } catch (err) {
      console.error("[ChainRouter] Failed to parse task definitions:", err);
      return;
    }

    const taskLinks: Array<{ link: string; def: { title: string; description: string; criteria: string; priority: number } | null }> = [
      { link: "plan", def: chainDef.tasks.plan },
      { link: "build", def: chainDef.tasks.build },
      { link: "verify", def: chainDef.tasks.verify },
      { link: "review", def: chainDef.tasks.review },
      { link: "accept", def: chainDef.tasks.accept },
    ];

    for (const { link, def } of taskLinks) {
      if (!def) continue;
      const task = await this.taskQueue.push(
        def.title,
        def.description,
        def.priority,
        this.leaderInstanceId,
        undefined,
        this.leaderName,
        undefined,
        link,
        chainDef.chain_id,
      );

      const tasksDir = path.join(this.cacheDir, "tasks");
      await fs.promises.mkdir(tasksDir, { recursive: true });
      const docPath = path.join(tasksDir, `${task.id}.md`);
      await fs.promises.writeFile(
        docPath,
        `# ${def.title}\n\n` +
        `**Link**: ${link}\n` +
        `**Chain**: ${chainDef.chain_id}\n` +
        `**Priority**: ${def.priority}\n\n` +
        `## Description\n\n${def.description}\n\n` +
        `## Completion Criteria\n\n${def.criteria}\n`,
      );

      this.eventBus.emit({
        type: "task_created",
        task: { ...task },
        taskId: task.id,
      });
    }

    this.eventBus.emit({ type: "chain_activated", chainId: chainDef.chain_id });
  }

  private async handleCompletionReport(msg: Message): Promise<void> {
    let decision: EvalDecision;
    try {
      decision = EvalDecisionSchema.parse(JSON.parse(msg.content));
    } catch {
      const currentLink = msg.link!;
      const nextLink = NEXT_LINKS[currentLink];
      if (nextLink) {
        decision = { decision: "activate_next", reason: "Auto-advance (no structured decision)", nextLink };
      } else if (nextLink === null && currentLink === "accept") {
        decision = { decision: "close_chain", reason: "Accept link completed" };
      } else {
        decision = { decision: "activate_next", reason: "Auto-advance", nextLink: NEXT_LINKS[currentLink] ?? undefined };
      }
    }

    switch (decision.decision) {
      case "activate_next": {
        const nextLink = decision.nextLink ?? NEXT_LINKS[msg.link!];
        if (!nextLink) break;

        const task = await this.taskQueue.push(
          `[${msg.reply_to ?? "chain"}] ${nextLink}`,
          "",
          1,
          this.leaderInstanceId,
          undefined,
          this.leaderName,
          undefined,
          nextLink,
          (msg as unknown as Record<string, unknown>).chain_id as string ?? null,
        );

        this.eventBus.emit({
          type: "task_created",
          task: { ...task },
          taskId: task.id,
        });
        break;
      }
      case "feedback": {
        if (msg.from_instance && decision.feedback) {
          await this.messageRouter.send(
            this.leaderInstanceId,
            this.leaderName,
            decision.feedback,
            msg.from_instance,
          );
        }
        break;
      }
      case "close_chain": {
        const chainId = (msg as unknown as Record<string, unknown>).chain_id as string;
        if (chainId) {
          this.eventBus.emit({ type: "chain_closed", chainId });
        }
        break;
      }
    }
  }

  private async findWorkerByRole(role: string): Promise<{ id: string; name: string } | null> {
    const instances = await this.zk.listInstances();
    for (const inst of instances) {
      if (inst.role === role && inst.status === "idle") {
        return { id: inst.id as string, name: inst.name as string };
      }
    }
    return null;
  }
}
