import * as fs from "node:fs";
import path from "node:path";
import { execWithTee } from "../utils/exec.js";
import { expandHomeDir } from "../config.js";
import { Logger } from "../utils/logger.js";

export class ClaudeRunner {
  private logger = new Logger("ClaudeRunner");
  private resolvedCache: string;

  constructor(
    private command: string,
    private cacheDir: string,
    private leaderInstanceId: string,
    private workDir: string,
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

  async run(prompt: string, logPath: string): Promise<{ code: number }> {
    if (Logger.isDebug()) {
      this.logger.debug(`Prompt (${prompt.length} chars):\n${prompt.slice(0, 1000)}${prompt.length > 1000 ? "\n... (truncated)" : ""}`);
      this.logger.debug(`Log: ${logPath}`);
    }
    return execWithTee(this.command, prompt, logPath, this.workDir);
  }
}
