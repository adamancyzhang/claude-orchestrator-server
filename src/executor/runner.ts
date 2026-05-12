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

  logPath(uniqueKey: string): string {
    return path.join(this.resolvedCache, `${uniqueKey}.log`);
  }

  resultPath(uniqueKey: string): string {
    return path.join(this.resolvedCache, `${uniqueKey}-result.md`);
  }

  evalResultPath(uniqueKey: string): string {
    return path.join(this.resolvedCache, `${uniqueKey}-eval-result.md`);
  }

  async run(prompt: string, logPath: string): Promise<{ code: number }> {
    return execWithTee(this.command, prompt, logPath, this.workDir);
  }
}
