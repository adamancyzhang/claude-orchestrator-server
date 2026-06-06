import type { SessionId } from "../ids.js";
import type { HookEvent } from "../hooks.js";

/**
 * Discriminated event extracted by the runtime from a single
 * stream-json line. Workers and the leader use this to decide what
 * to surface in the TUI (assistant text live, tool_use as "Now:"
 * actions, thinking as a placeholder, result as final text).
 */
export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking" }
  | { kind: "tool_use"; tool: string; summary: string }
  | { kind: "result"; text: string | null; is_error: boolean }
  | { kind: "system" }
  | { kind: "other" };

export interface StreamChunk {
  raw: string;
  text?: string;
  is_final: boolean;
  event?: StreamEvent;
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
