import type { SessionId } from "../ids.js";
import type { HookEvent } from "../hooks.js";

export interface StreamChunk {
  raw: string;
  text?: string;
  is_final: boolean;
}

export interface RunOptions {
  prompt: string;
  log_path: string;
  system_prompt?: string;
  resume_session_id?: SessionId;
  fork_session?: boolean;
  cwd?: string;
  on_chunk?: (chunk: StreamChunk) => void;
  quiet?: boolean;
}

export interface RunResult {
  exit_code: number;
  session_id: SessionId | null;
  log_path: string;
}

export interface IClaudeRunner {
  run(opts: RunOptions): Promise<RunResult>;
}

export interface ITemplateEngine {
  load(name: string): string;
  render(name: string, vars: Record<string, string>): string;
  has(name: string): boolean;
}

export interface IHookEngine {
  fire(event: HookEvent): Promise<void>;
}
