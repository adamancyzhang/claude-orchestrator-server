import * as fs from "node:fs";
import * as path from "node:path";
import { ZkClient } from "../zk/client.js";
import { TaskQueue } from "../modules/task-queue.js";
import { MessageRouter } from "../modules/message-router.js";
import type { Message } from "../models/schemas.js";
import { expandHomeDir } from "../config.js";
import { execAndCapture } from "../utils/exec.js";

const NEXT_LINKS: Record<string, string | null> = {
  plan: "build",
  build: "verify",
  verify: "review",
  review: "accept",
  accept: null,
};

export interface DecisionContext {
  teamStatus: object;
  taskQueues: object;
  chainStatus: object;
}

export interface Decision {
  decision: "pass" | "feedback" | "reject";
  reason: string;
  feedbackToWorker?: string;
  nextAction: {
    action: "activate_next_link" | "reassign" | "close_chain" | "broadcast_help" | "none";
    nextLink: string | null;
    suggestedWorker: string | null;
    messageToWorker: string | null;
  };
}

export class DecisionEngine {
  private template: string | null = null;
  private templatePath: string;

  constructor(
    private zk: ZkClient,
    private taskQueue: TaskQueue,
    private messageRouter: MessageRouter,
    private command: string,
    private cacheDir: string,
    private leaderInstanceId: string,
    templatePath?: string,
  ) {
    this.templatePath = templatePath ?? path.join(process.cwd(), ".claude-orchestrator", "agents", "leader-decide.md");
  }

  private async loadTemplate(): Promise<string> {
    if (this.template) return this.template;
    try {
      this.template = await fs.promises.readFile(this.templatePath, "utf-8");
    } catch {
      throw new Error(`Decide template not found at ${this.templatePath}. Run setup first.`);
    }
    return this.template;
  }

  async evaluate(report: Message, context: DecisionContext): Promise<Decision> {
    const template = await this.loadTemplate();

    const prompt = template
      .replace("{{team_status}}", JSON.stringify(context.teamStatus, null, 2))
      .replace("{{task_queues}}", JSON.stringify(context.taskQueues, null, 2))
      .replace("{{chain_status}}", JSON.stringify(context.chainStatus, null, 2))
      .replace("{{content}}", report.content);

    const uniqueKey = `decide-${Date.now().toString(36)}`;
    const resolvedCacheDir = expandHomeDir(path.join(this.cacheDir, this.leaderInstanceId));
    const logPath = path.join(resolvedCacheDir, `${uniqueKey}.log`);

    const { stdout } = await execAndCapture(this.command, prompt, logPath);
    const decision = this.parseOutput(stdout);

    await this.executeDecision(decision, report);

    return decision;
  }

  private async executeDecision(decision: Decision, report: Message): Promise<void> {
    const nextLink = decision.nextAction.nextLink;
    const linkOrder = ["plan", "build", "verify", "review", "accept"];

    switch (decision.nextAction.action) {
      case "activate_next_link": {
        if (!nextLink) break;
        const pending = await this.zk.listPendingTasks();
        for (const [taskId, data] of pending) {
          if (data.link === nextLink && data.chain_id === (report as Record<string, unknown>).chain_id) {
            // Task already exists in pending, no need to create
            break;
          }
        }
        break;
      }
      case "close_chain":
        break;
      case "reassign":
      case "broadcast_help":
      case "none":
        break;
    }

    if (decision.decision === "feedback" && decision.feedbackToWorker && report.from_instance) {
      await this.messageRouter.send(
        this.leaderInstanceId,
        "Leader",
        decision.feedbackToWorker,
        report.from_instance,
      );
    }
  }

  private parseOutput(output: string): Decision {
    const cleaned = output
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    return {
      decision: parsed.decision ?? "pass",
      reason: parsed.reason ?? "",
      feedbackToWorker: parsed.feedback_to_worker,
      nextAction: {
        action: parsed.next_action?.action ?? "none",
        nextLink: parsed.next_action?.next_link ?? null,
        suggestedWorker: parsed.next_action?.suggested_worker ?? null,
        messageToWorker: parsed.next_action?.message_to_worker ?? null,
      },
    };
  }
}
