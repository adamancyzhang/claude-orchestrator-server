import * as fs from "node:fs";
import path from "node:path";
import { execWithStreaming } from "../utils/exec.js";
import { expandHomeDir } from "../config.js";
import { Logger } from "../utils/logger.js";

export interface WorkerIdentity {
  name: string;
  role: string;
  worktreePath: string;
  worktreeBranch: string;
  instanceId: string;
}

export class ClaudeRunner {
  private logger = new Logger("ClaudeRunner");
  private resolvedCache: string;

  constructor(
    private command: string,
    private cacheDir: string,
    private leaderInstanceId: string,
    private workDir: string,
    private identity: WorkerIdentity,
    private identityTemplate?: string,
    private onChunk?: (line: string) => void,
    private quiet = false,
  ) {
    this.resolvedCache = expandHomeDir(path.join(this.cacheDir, this.leaderInstanceId));
  }

  private dateDir(): string {
    return new Date().toISOString().slice(0, 10);
  }

  ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
  }

  taskDocPath(taskId: string): string {
    const dir = path.join(this.resolvedCache, "tasks", this.dateDir());
    this.ensureDir(dir);
    return path.join(dir, `${taskId}.md`);
  }

  logPath(uniqueKey: string): string {
    const dir = path.join(this.resolvedCache, "logs", this.dateDir());
    this.ensureDir(dir);
    return path.join(dir, `${uniqueKey}.log`);
  }

  resultPath(uniqueKey: string): string {
    const dir = path.join(this.resolvedCache, "results", this.dateDir());
    this.ensureDir(dir);
    return path.join(dir, `${uniqueKey}-result.md`);
  }

  evalLogPath(uniqueKey: string): string {
    const dir = path.join(this.resolvedCache, "eval", this.dateDir());
    this.ensureDir(dir);
    return path.join(dir, `${uniqueKey}-eval.log`);
  }

  evalResultPath(uniqueKey: string): string {
    const dir = path.join(this.resolvedCache, "eval", this.dateDir());
    this.ensureDir(dir);
    return path.join(dir, `${uniqueKey}-eval-result.md`);
  }

  buildIdentityPrompt(): string {
    if (!this.identityTemplate) return "";
    return this.identityTemplate
      .replace(/\{\{name\}\}/g, this.identity.name)
      .replace(/\{\{role\}\}/g, this.identity.role)
      .replace(/\{\{worktreePath\}\}/g, this.identity.worktreePath)
      .replace(/\{\{worktreeBranch\}\}/g, this.identity.worktreeBranch)
      .replace(/\{\{instanceId\}\}/g, this.identity.instanceId);
  }

  async run(
    prompt: string,
    logPath: string,
    opts?: {
      systemPrompt?: string;
      resumeSessionId?: string;
      forkSession?: boolean;
    },
  ): Promise<{ code: number; sessionId?: string }> {
    if (Logger.isDebug()) {
      this.logger.debug(`Prompt (${prompt.length} chars):\n${prompt.slice(0, 1000)}${prompt.length > 1000 ? "\n... (truncated)" : ""}`);
      this.logger.debug(`Log: ${logPath}`);
    }
    let cmd = this.command;
    if (opts?.resumeSessionId) {
      cmd = `${cmd} --resume ${opts.resumeSessionId}`;
      if (opts?.forkSession) {
        cmd = `${cmd} --fork-session`;
      }
    }
    return execWithStreaming(cmd, prompt, logPath, opts?.systemPrompt, this.onChunk, this.workDir, this.quiet);
  }
}
