import {
  asSessionId,
  ClaudeRunnerError,
  type IClaudeRunner,
  type ILogger,
  type RunOptions,
  type RunResult,
} from "@co/contracts";
import { execWithStreaming } from "@co/infra";
import { parseStreamLine } from "./stream-json.js";

export interface BuildIdentityInput {
  name: string;
  role: string;
  origin_branch?: string | null;
  worktree_path: string;
  worktree_branch: string;
  co_root: string;
  co_role_path: string;
}

export class ClaudeRunner implements IClaudeRunner {
  constructor(
    private readonly command: string,
    private readonly logger: ILogger,
  ) {}

  static buildIdentityPrompt(
    template: string,
    input: BuildIdentityInput,
  ): string {
    return template
      .replace(/\{\{name\}\}/g, input.name)
      .replace(/\{\{role\}\}/g, input.role)
      .replace(/\{\{originBranch\}\}/g, input.origin_branch ?? "")
      .replace(/\{\{worktreePath\}\}/g, input.worktree_path)
      .replace(/\{\{worktreeBranch\}\}/g, input.worktree_branch)
      .replace(/\{\{co_root\}\}/g, input.co_root)
      .replace(/\{\{co_role_path\}\}/g, input.co_role_path);
  }

  async run(opts: RunOptions): Promise<RunResult> {
    this.logger.debug("ClaudeRunner.run", {
      prompt_chars: opts.prompt.length,
      log_path: opts.log_path,
      has_system_prompt: Boolean(opts.system_prompt),
      resume: opts.resume_session_id ?? null,
      fork: opts.fork_session ?? false,
    });

    const { exit_code, session_id, spawn_error } = await execWithStreaming({
      command: this.command,
      prompt: opts.prompt,
      log_path: opts.log_path,
      system_prompt: opts.system_prompt,
      resume_session_id: opts.resume_session_id,
      fork_session: opts.fork_session,
      cwd: opts.cwd,
      quiet: opts.quiet,
      on_line: opts.on_chunk
        ? (line) => {
            const event = parseStreamLine(line) ?? undefined;
            const text = event?.kind === "text" ? event.text : undefined;
            opts.on_chunk?.({
              raw: line,
              text,
              is_final: false,
              event,
            });
          }
        : undefined,
    });

    if (exit_code !== 0) {
      this.logger.warn("ClaudeRunner.run non-zero exit", {
        exit_code,
        log_path: opts.log_path,
        spawn_error: spawn_error ?? null,
      });
    }

    if (spawn_error) {
      throw new ClaudeRunnerError(
        `Failed to spawn claude-cli: ${spawn_error}`,
      );
    }
    if (exit_code < 0) {
      throw new ClaudeRunnerError(
        `Failed to spawn claude-cli (exit ${exit_code})`,
      );
    }

    return {
      exit_code,
      session_id: session_id ? asSessionId(session_id) : null,
      log_path: opts.log_path,
    };
  }
}
