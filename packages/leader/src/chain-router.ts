import * as fs from "node:fs";
import { extractJson } from "@co/runtime";
import {
  ChainDefSchema,
  EvalDecisionSchema,
  ValidationError,
  type ChainDef,
  type ChainId,
  type EvalDecision,
  type IClaudeRunner,
  type IEventBus,
  type IInstanceRegistry,
  type ILogger,
  type IMessageRouter,
  type ITaskQueue,
  type ITemplateEngine,
  type InstanceId,
  type LeaderEvent,
  type Message,
  type TaskLink,
  cachePaths,
  asChainId,
} from "@co/contracts";

const NEXT_LINKS: Record<TaskLink, TaskLink | null> = {
  plan: "build",
  build: "verify",
  verify: "review",
  review: "accept",
  accept: null,
};

const LINK_TO_ROLE: Record<TaskLink | "decompose", string> = {
  plan: "planner",
  build: "builder",
  verify: "verifier",
  review: "reviewer",
  accept: "accepter",
  decompose: "planner",
};

export interface ChainRouterOptions {
  task_queue: ITaskQueue;
  message_router: IMessageRouter;
  registry: IInstanceRegistry;
  bus: IEventBus<LeaderEvent>;
  runner: IClaudeRunner;
  template_engine: ITemplateEngine;
  logger: ILogger;
  leader_id: InstanceId;
  leader_name: string;
  cache_paths: cachePaths.CachePathOptions;
}

export class ChainRouter {
  constructor(private readonly opts: ChainRouterOptions) {}

  async route(msg: Message): Promise<void> {
    if (!msg.link) {
      await this.handleRequirement(msg);
      return;
    }
    if (msg.link === "plan" && msg.type === "completion_report") {
      await this.handleCompletionReport(msg);
      return;
    }
    if (this.looksLikeChainDef(msg.content)) {
      await this.handleTaskDefinitions(msg);
      return;
    }
    await this.handleCompletionReport(msg);
  }

  private looksLikeChainDef(content: string): boolean {
    try {
      const json = JSON.parse(extractJson(content)) as Record<string, unknown>;
      return Boolean(json && typeof json === "object" && "chain_id" in json && "tasks" in json);
    } catch {
      return false;
    }
  }

  private async handleRequirement(msg: Message): Promise<void> {
    if (this.opts.template_engine.has("worker-decompose.md")) {
      const logKey = `leader-decompose-${msg.id || Date.now().toString(36)}`;
      const logPath = cachePaths.messageLogPath(this.opts.cache_paths, msg.id);
      const resultPath = cachePaths.taskResultPath(
        this.opts.cache_paths,
        msg.task_id ?? (logKey as never),
      );
      await fs.promises.mkdir(require("node:path").dirname(resultPath), { recursive: true });

      const prompt = this.opts.template_engine.render("worker-decompose.md", {
        name: this.opts.leader_name,
        role: "leader",
        task_title: msg.task_title ?? "",
        task_description: msg.task_description ?? msg.content,
        task_criteria: msg.task_criteria ?? "",
        task_doc_path: msg.task_doc_path ?? "",
        result_path: resultPath,
        work_dir: process.cwd(),
        time: new Date().toISOString(),
        content: msg.content,
      });
      await this.opts.runner.run({ prompt, log_path: logPath });
      const resultContent = await fs.promises.readFile(resultPath, "utf-8");
      const cleaned = extractJson(resultContent);
      await this.handleTaskDefinitions({ ...msg, content: cleaned });
      return;
    }

    const planner = await this.findIdleWorkerByRole("planner");
    if (!planner) {
      this.opts.logger.warn("no planner available — requirement dropped");
      return;
    }
    await this.opts.message_router.send({
      type: "task_dispatch",
      from_instance: this.opts.leader_id,
      from_name: this.opts.leader_name,
      from_role: "leader",
      to_instance: planner.id,
      content: msg.content,
      link: "plan",
      task_description: msg.content,
    });
  }

  private async handleTaskDefinitions(msg: Message): Promise<void> {
    const parsed = ChainDefSchema.safeParse(JSON.parse(extractJson(msg.content)));
    if (!parsed.success) {
      throw new ValidationError("invalid ChainDef in message", parsed.error);
    }
    const chainDef: ChainDef = parsed.data;
    const linkOrder: Array<TaskLink> = ["plan", "build", "verify", "review", "accept"];
    let firstLink: TaskLink | null = null;
    let firstTaskId: string | null = null;
    let firstTitle = "";

    for (const link of linkOrder) {
      const def = chainDef.tasks[link];
      if (!def) continue;
      const task = await this.opts.task_queue.push({
        title: def.title,
        description: def.description,
        priority: def.priority,
        link,
        chain_id: chainDef.chain_id,
        created_by: this.opts.leader_id,
        created_by_name: this.opts.leader_name,
      });
      if (firstLink === null) {
        firstLink = link;
        firstTaskId = task.id;
        firstTitle = def.title;
      }
    }

    this.opts.bus.emit({ type: "chain_activated", chain_id: chainDef.chain_id });

    if (firstLink && firstTaskId) {
      const worker = await this.findIdleWorkerByRole(LINK_TO_ROLE[firstLink]);
      if (worker) {
        await this.opts.message_router.send({
          type: "task_dispatch",
          from_instance: this.opts.leader_id,
          from_name: this.opts.leader_name,
          from_role: "leader",
          to_instance: worker.id,
          content: firstTitle,
          link: firstLink,
          chain_id: chainDef.chain_id,
          task_id: firstTaskId as never,
          task_title: firstTitle,
        });
      } else {
        this.opts.logger.warn(`no ${LINK_TO_ROLE[firstLink]} available — task queued`);
      }
    }
  }

  private async handleCompletionReport(msg: Message): Promise<void> {
    const parsed = EvalDecisionSchema.safeParse(
      JSON.parse(extractJson(msg.content)),
    );
    if (!parsed.success) {
      throw new ValidationError("invalid EvalDecision", parsed.error);
    }
    const decision: EvalDecision = parsed.data;

    switch (decision.decision) {
      case "activate_next": {
        if (!msg.chain_id) break;
        const nextLink = decision.next_link;
        const newTask = await this.opts.task_queue.push({
          title: `[${msg.chain_id}] ${nextLink}`,
          link: nextLink,
          chain_id: msg.chain_id,
          priority: 1,
          created_by: this.opts.leader_id,
          created_by_name: this.opts.leader_name,
        });
        const worker = await this.findIdleWorkerByRole(LINK_TO_ROLE[nextLink]);
        if (worker) {
          await this.opts.message_router.send({
            type: "task_dispatch",
            from_instance: this.opts.leader_id,
            from_name: this.opts.leader_name,
            from_role: "leader",
            to_instance: worker.id,
            content: newTask.title,
            link: nextLink,
            chain_id: msg.chain_id,
            task_id: newTask.id,
            task_title: newTask.title,
          });
        }
        break;
      }
      case "feedback": {
        const targetId = decision.feedback_target ?? msg.from_instance;
        await this.opts.message_router.send({
          type: "direct",
          from_instance: this.opts.leader_id,
          from_name: this.opts.leader_name,
          from_role: "leader",
          to_instance: targetId,
          content: decision.feedback_to_worker,
          link: msg.link,
          chain_id: msg.chain_id,
        });
        break;
      }
      case "reject":
      case "close_chain": {
        if (msg.chain_id) {
          this.emitChainClosed(msg.chain_id);
        }
        break;
      }
    }
  }

  private emitChainClosed(chainId: ChainId): void {
    this.opts.bus.emit({ type: "chain_closed", chain_id: asChainId(chainId) });
  }

  private async findIdleWorkerByRole(
    role: string,
  ): Promise<{ id: InstanceId; name: string } | null> {
    const instances = await this.opts.registry.list();
    for (const inst of instances) {
      if (inst.role === role && inst.status === "idle") {
        return { id: inst.id, name: inst.name };
      }
    }
    return null;
  }
}
