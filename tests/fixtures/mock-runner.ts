import { vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

export interface MockRunnerCall {
  prompt: string;
  logPath: string;
  opts?: {
    systemPrompt?: string;
    resumeSessionId?: string;
    forkSession?: boolean;
  };
}

export class MockClaudeRunner {
  private responses: string[] = [];
  private resultByPath = new Map<string, string>();
  calls: MockRunnerCall[] = [];
  identityPrompt = "";

  constructor(public cacheDir: string = "/tmp/mock-cache") {}

  setResponse(responses: string[]): void {
    this.responses = [...responses];
  }

  setResultForPath(path: string, content: string): void {
    this.resultByPath.set(path, content);
  }

  buildIdentityPrompt(): string {
    return this.identityPrompt;
  }

  private mkdir(p: string): string {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return p;
  }
  taskDocPath = vi.fn((taskId: string): string => this.mkdir(`${this.cacheDir}/tasks/${taskId}.md`));
  logPath = vi.fn((key: string): string => this.mkdir(`${this.cacheDir}/logs/${key}.log`));
  resultPath = vi.fn((key: string): string => this.mkdir(`${this.cacheDir}/results/${key}-result.md`));
  evalLogPath = vi.fn((key: string): string => this.mkdir(`${this.cacheDir}/eval/${key}-eval.log`));
  evalResultPath = vi.fn((key: string): string => this.mkdir(`${this.cacheDir}/eval/${key}-eval-result.md`));
  ensureDir = vi.fn((dir: string): void => { fs.mkdirSync(dir, { recursive: true }); });

  run = vi.fn(async (prompt: string, logPath: string, opts?: MockRunnerCall["opts"]) => {
    this.calls.push({ prompt, logPath, opts });
    // Optionally write programmed response to log/result files via the fs mock
    const next = this.responses.shift();
    return { code: 0, sessionId: "mock-session", _response: next };
  });
}
