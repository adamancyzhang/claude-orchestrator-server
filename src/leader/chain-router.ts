import * as fs from "node:fs";
import { ZkClient } from "../zk/client.js";
import { TaskQueue } from "../modules/task-queue.js";
import { MessageRouter } from "../modules/message-router.js";
import { LeaderEventBus } from "./event-bus.js";
import { MergeValidator } from "./merge-validator.js";
import { Logger } from "../utils/logger.js";
import { ClaudeRunner } from "../executor/runner.js";
import { TemplateEngine } from "../executor/template.js";
import {
  MessageSchema,
  createMessage,
  ChainDefSchema,
  EvalDecisionSchema,
  type Message,
  type EvalDecision,
} from "../models/schemas.js";
import { extractJson } from "../utils/json.js";

const NEXT_LINKS: Record<string, string | null> = {
  plan: "build",
  build: "verify",
  verify: "review",
  review: "accept",
  accept: null,
};

const LINK_TO_ROLE: Record<string, string> = {
  plan: "planner",
  build: "builder",
  verify: "verifier",
  review: "reviewer",
  accept: "accepter",
  decompose: "leader",
};

export class ChainRouter {
  private logger = new Logger("ChainRouter");
  private taskDocTemplate: string | null = null;

  constructor(
    private zk: ZkClient,
    private taskQueue: TaskQueue,
    private messageRouter: MessageRouter,
    private eventBus: LeaderEventBus,
    private leaderInstanceId: string,
    private leaderName: string,
    private runner: ClaudeRunner,
    private templateEngine: TemplateEngine,
    private mergeValidator: MergeValidator | null = null,
  ) {}

  async route(msg: Message): Promise<void> {
    const link = msg.link;
    if (Logger.isDebug()) {
      this.eventBus.emit({ type: "debug_info", message: `Routing msg ${msg.id}: link=${link ?? "none"}, from=${msg.from_name}` });
    }
    if (!link) {
      return this.handleRequirement(msg);
    }
    if (link === "task_defs") {
      return this.handleTaskDefinitions(msg);
    }
    return this.handleCompletionReport(msg);
  }

  private async handleRequirement(msg: Message): Promise<void> {
    const template = this.templateEngine.get("decompose");

    if (template) {
      // Leader self-processes decompose
      const uniqueKey = `leader-decompose-${msg.id || Date.now().toString(36)}`;
      const resultPath = this.runner.resultPath(uniqueKey);
      const logPath = this.runner.logPath(uniqueKey);

      const prompt = this.templateEngine.render(template, {
        task_title: msg.task_title ?? "",
        task_description: msg.task_description ?? msg.content,
        task_criteria: msg.task_criteria ?? "",
        task_doc_path: msg.task_doc_path ?? "",
        result_path: resultPath,
        work_dir: process.cwd(),
        time: new Date().toISOString(),
        content: msg.content,
      });

      this.logger.info(`Leader self-processing decompose: "${msg.content.slice(0, 80)}"`);

      this.eventBus.emit({
        type: "stream_start",
        instanceId: this.leaderInstanceId,
        logPath,
        taskId: msg.id,
      });

      await this.runner.run(prompt, logPath, {
        systemPrompt: this.runner.buildIdentityPrompt(),
      });

      this.eventBus.emit({
        type: "stream_end",
        instanceId: this.leaderInstanceId,
        logPath,
      });

      try {
        const resultContent = await fs.promises.readFile(resultPath, "utf-8");
        const cleanedContent = extractJson(resultContent);
        const syntheticMsg = createMessage({
          from_instance: this.leaderInstanceId,
          from_name: this.leaderName,
          from_role: "leader",
          to_instance: this.leaderInstanceId,
          content: cleanedContent,
          link: "task_defs",
        });
        await this.handleTaskDefinitions(syntheticMsg);
      } catch (err) {
        this.logger.error("Failed to read decompose result, falling back to planner", err);
        await this.forwardToPlanner(msg);
      }
    } else {
      // Fallback: forward to planner worker
      await this.forwardToPlanner(msg);
    }
  }

  private async forwardToPlanner(msg: Message): Promise<void> {
    const planner = await this.findWorkerByRole("planner");
    if (!planner) {
      this.logger.error("No planner worker available. Requirement not processed.");
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
    this.logger.info(`Forwarded requirement to planner ${planner.name} (${planner.id.slice(0, 8)})`);
    if (Logger.isDebug()) {
      this.eventBus.emit({ type: "debug_info", message: `Requirement "${msg.content.slice(0, 80)}" → planner ${planner.name}` });
    }
  }


  private async handleTaskDefinitions(msg: Message): Promise<void> {
    let chainDef;
    try {
      chainDef = ChainDefSchema.parse(JSON.parse(extractJson(msg.content)));
    } catch (err) {
      this.logger.error("Failed to parse task definitions", err);
      return;
    }

    const taskLinks: Array<{ link: string; def: { title: string; description: string; criteria: string; priority: number } | null }> = [
      { link: "plan", def: chainDef.tasks.plan },
      { link: "build", def: chainDef.tasks.build },
      { link: "verify", def: chainDef.tasks.verify },
      { link: "review", def: chainDef.tasks.review },
      { link: "accept", def: chainDef.tasks.accept },
    ];

    const createdTasks = new Map<string, { taskId: string; docPath: string; def: typeof taskLinks[number]["def"] }>();

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

      if (this.taskDocTemplate === null) {
        this.taskDocTemplate = await this.templateEngine.loadFile("worker-task-doc.md");
      }
      const docPath = this.runner.taskDocPath(task.id);
      const docContent = this.templateEngine.render(this.taskDocTemplate, {
        title: def.title,
        link,
        chain_id: chainDef.chain_id,
        priority: String(def.priority),
        description: def.description,
        criteria: def.criteria,
      });
      await fs.promises.writeFile(docPath, docContent);

      createdTasks.set(link, { taskId: task.id, docPath, def });

      this.eventBus.emit({
        type: "task_created",
        task: { ...task },
        taskId: task.id,
      });
    }

    this.eventBus.emit({ type: "chain_activated", chainId: chainDef.chain_id });
    if (Logger.isDebug()) {
      const linkCount = taskLinks.filter(t => t.def).length;
      this.eventBus.emit({ type: "debug_info", message: `Chain ${chainDef.chain_id}: ${linkCount} tasks created` });
    }

    // Send message to the first worker in the chain to start processing
    const firstLink = taskLinks.find(t => t.def)?.link;
    if (firstLink && createdTasks.has(firstLink)) {
      const role = LINK_TO_ROLE[firstLink];
      const worker = await this.findWorkerByRole(role);
      if (worker) {
        const { docPath, def } = createdTasks.get(firstLink)!;
        await this.sendTaskToWorker(worker, firstLink, def!, docPath, chainDef.chain_id, createdTasks.get(firstLink)!.taskId);
      } else {
        this.logger.error(`No ${role} worker available. Chain ${chainDef.chain_id} waiting for worker.`);
      }
    }
  }

  private async handleCompletionReport(msg: Message): Promise<void> {
    // Try merge validation if commit info is present
    if (this.mergeValidator) {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.commit?.sha) {
          this.mergeValidator.validate({
            sha: parsed.commit.sha,
            message: parsed.commit.message,
            branch: parsed.commit.branch,
            taskTitle: (msg.task_title as string) ?? "unknown",
            taskLink: (msg.link as string) ?? "unknown",
          }).catch(() => { /* best effort */ });
        }
      } catch {
        // Content is not JSON, skip merge validation
        this.logger.debug("Report content is not JSON, skipping merge validation");
      }
    }

    let decision: EvalDecision;
    let parsed = true;
    try {
      decision = EvalDecisionSchema.parse(JSON.parse(extractJson(msg.content)));
    } catch (err) {
      this.logger.warn(`Failed to parse EvalDecision, synthesizing fallback: ${err instanceof Error ? err.message : String(err)}`);
      parsed = false;
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

    if (Logger.isDebug()) {
      this.eventBus.emit({ type: "debug_info", message: `EvalDecision: ${decision.decision} (${decision.reason})${parsed ? "" : " [fallback]"}` });
    }

    switch (decision.decision) {
      case "activate_next": {
        const nextLink = decision.nextLink ?? NEXT_LINKS[msg.link!];
        if (!nextLink) break;

        const chainId = (msg as unknown as Record<string, unknown>).chain_id as string ?? null;

        const task = await this.taskQueue.push(
          `[${msg.reply_to ?? "chain"}] ${nextLink}`,
          "",
          1,
          this.leaderInstanceId,
          undefined,
          this.leaderName,
          undefined,
          nextLink,
          chainId,
        );

        this.eventBus.emit({
          type: "task_created",
          task: { ...task },
          taskId: task.id,
        });

        // Find worker and send message for the next link
        const role = LINK_TO_ROLE[nextLink];
        if (role) {
          const worker = await this.findWorkerByRole(role);
          if (worker) {
            // Try to find pending task with full details from handleTaskDefinitions
            const pending = await this.findPendingTaskByChainLink(chainId, nextLink);
            const docPath = this.runner.taskDocPath(task.id);
            const def = pending
              ? { title: pending.title as string, description: (pending.description as string) || "", criteria: "", priority: (pending.priority as number) ?? 1 }
              : { title: task.title, description: task.description, criteria: "", priority: 1 };
            await this.sendTaskToWorker(worker, nextLink, def, docPath, chainId ?? "", task.id);
          } else {
            this.logger.info(`No ${role} worker available for ${nextLink}, task queued`);
          }
        }
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

  private async findPendingTaskByChainLink(chainId: string | null, link: string): Promise<Record<string, unknown> | null> {
    if (!chainId) return null;
    const pending = await this.taskQueue.listTasks("pending");
    for (const t of pending) {
      if ((t as Record<string, unknown>).chain_id === chainId && (t as Record<string, unknown>).link === link) {
        return t as unknown as Record<string, unknown>;
      }
    }
    return null;
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

  private async sendTaskToWorker(
    worker: { id: string; name: string },
    link: string,
    def: { title: string; description: string; criteria: string; priority: number },
    docPath: string,
    chainId: string,
    taskId?: string,
  ): Promise<void> {
    await this.zk.createMessage(worker.id, {
      type: "direct",
      from_instance: this.leaderInstanceId,
      from_name: this.leaderName,
      from_role: "leader",
      to_instance: worker.id,
      content: def.description,
      created_at: new Date().toISOString(),
      read: false,
      link,
      task_title: def.title,
      task_description: def.description,
      task_criteria: def.criteria,
      task_doc_path: docPath,
      chain_id: chainId,
      task_id: taskId ?? null,
    } as unknown as Record<string, unknown>);
    this.logger.info(`Sent ${link} task to ${worker.name} (${worker.id.slice(0, 8)})`);
  }
}
