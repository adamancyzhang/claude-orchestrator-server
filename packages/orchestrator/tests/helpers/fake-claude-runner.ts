// TRUST-JUSTIFICATION: Stub IClaudeRunner used by
// `packages/orchestrator/tests/core/e2e/leader-worker-communication.test.ts`.
// Downstream: replaces `ClaudeRunner.run()` which spawns `claude -p`.
// Reason: a full plan→execute→verify→review→accept chain calls claude-cli
//   ~12 times per worker (task + commit-message + eval per link, plus
//   decompose at the leader). At ~30 s / ~$0.10 per call this would be
//   ~$6 and ~6 min per test run with strong non-determinism — impractical
//   for an automated regression. The fake returns canned outputs that
//   satisfy each downstream consumer's schema contract:
//     * decompose      → ChainDef JSON (chain.ts:13)
//     * worker task    → markdown body (validateOutput in watcher.ts:387)
//     * self-evaluate  → EvalDecision JSON (eval.ts:21)
//     * commit message → single text line
// Evidence: the schema contracts ARE the protocol that
//   packages/leader/src/chain-router.ts and packages/worker/src/{watcher,
//   evaluator,commit-checker,docs-committer}.ts treat as ground truth.
//   Tests assert on those downstream effects (ZK message shape, manifest
//   contents, dual commits), not on claude-cli's actual output.

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  asSessionId,
  type IClaudeRunner,
  type RunOptions,
  type RunResult,
} from "@co/contracts";

/**
 * Phases the fake distinguishes. Routed by inspecting the rendered
 * `opts.prompt` body for template-specific opener strings.
 */
export type FakePhase =
  | "decompose"
  | "worker_task"
  | "evaluate"
  | "commit_message"
  | "merge_decision";

export interface InvocationRecord {
  phase: FakePhase;
  /** Best-effort: role inferred from `opts.system_prompt`, or null. */
  role: string | null;
  /** Path the fake wrote the canned response to. */
  output_path: string;
  /** Length of the rendered prompt — useful for sanity checks. */
  prompt_chars: number;
  /** Snapshot of the rendered prompt for diagnosis when an assertion fails. */
  prompt_excerpt: string;
  /**
   * `,`-joined `<link>=<sha-or-empty>` pairs scraped out of the rendered
   * prompt's `upstream_*_commit` substitutions. Empty string when not
   * a worker_task phase or when no upstream commits were rendered.
   */
  upstream_echo: string;
}

export interface PhaseContext {
  phase: FakePhase;
  role: string | null;
  prompt: string;
  result_path: string | null;
  log_path: string;
}

/**
 * Per-phase canned-response producers. Each returns the **text** that
 * should be written to the phase's expected output file:
 *   - decompose      → goes to result_path (parsed from prompt)
 *   - worker_task    → goes to result_path
 *   - evaluate       → goes to result_path
 *   - commit_message → goes to log_path (CommitChecker reads its first
 *                      line as the commit message; see commit-checker.ts:133)
 */
export type PhaseScript = (ctx: PhaseContext) => string;

export interface FakeClaudeRunnerOptions {
  /**
   * Override scripts for a phase. Unset phases fall back to {@link defaultScripts}.
   */
  scripts?: Partial<Record<FakePhase, PhaseScript>>;
  /**
   * Side-effect callback fired AFTER the canned output is written. The
   * in-process worker supervisor uses this to touch a file in the
   * worker's worktree so `CommitChecker.check` finds something to commit.
   */
  on_after_write?: (record: InvocationRecord, ctx: PhaseContext) => void;
  /**
   * When set, the fake auto-touches `<worktree_path>/.co-test/<phase>-<n>.md`
   * after every `worker_task` invocation, ensuring `CommitChecker.check`
   * (packages/worker/src/commit-checker.ts:44-52) finds a real change in
   * this worker's worktree and produces a non-null commit SHA. Tests need
   * this for §9 item 4 (dual-commit assertions) to be meaningful.
   */
  worktree_path?: string;
  /**
   * Shared invocation log. When multiple FakeClaudeRunner instances
   * (one per worker) push to the same array, the test gets a unified
   * cross-worker call count without losing per-worker observability.
   */
  shared_invocations?: InvocationRecord[];
}

/**
 * Schema-valid defaults. Tests can override individual phases via the
 * `scripts` option to inject failure modes (e.g. invalid JSON to exercise
 * the evaluator's 3-retry loop).
 */
export const defaultScripts: Record<FakePhase, PhaseScript> = {
  decompose: () => {
    // ChainDef compatible with ChainDefSchema (packages/contracts/src/schemas/chain.ts:13).
    // chain_id is sequenced by the leader's chain-router based on a UUID; here
    // we hand back any string and the schema's z.string().transform(asChainId)
    // will brand it. For deterministic test snapshots we use a hash of the
    // current iso-second so reruns get different chains.
    const chainId = `chain-${Date.now().toString(36)}`;
    return JSON.stringify({
      chain_id: chainId,
      chain_title: "eval-02 test chain",
      tasks: {
        plan: {
          title: "plan: layout the change",
          description: "Sketch the implementation steps.",
          criteria: "A short markdown plan exists in result.md.",
          priority: 1,
        },
        execute: {
          title: "execute: apply the change",
          description: "Make the documented edits.",
          criteria: "Edits land on the worktree branch.",
          priority: 1,
        },
        verify: {
          title: "verify: typecheck + tests",
          description: "Run typecheck and any tests.",
          criteria: "No new errors.",
          priority: 1,
        },
        review: {
          title: "review: read the diff",
          description: "Skim the diff for obvious issues.",
          criteria: "Review notes recorded.",
          priority: 1,
        },
        accept: {
          title: "accept: gate merge",
          description: "Confirm the change meets the acceptance criteria.",
          criteria: "Acceptance verdict recorded.",
          priority: 1,
        },
      },
    });
  },
  worker_task: (ctx) => {
    // The result.md content is consumed downstream only as text — content
    // shape doesn't matter as long as it's non-empty (watcher.ts:387 only
    // checks size > 0 and non-whitespace).
    return [
      `# fake ${ctx.role ?? "worker"} result`,
      "",
      "Synthetic completion artifact produced by FakeClaudeRunner.",
      "",
      `result_path=${ctx.result_path ?? "(unparsed)"}`,
    ].join("\n");
  },
  evaluate: (ctx) => {
    // For accept link → close_chain; for everything else → activate_next.
    // We infer the link from the rendered prompt — worker-evaluate.md
    // renders `**Link**: <link>` near the top (see template line 4-9).
    const linkMatch = ctx.prompt.match(/\*\*Link\*\*:\s*([a-z_]+)/);
    const link = linkMatch?.[1] ?? "execute";
    if (link === "accept") {
      return JSON.stringify({
        decision: "close_chain",
        reason: "all chain criteria met (canned)",
      });
    }
    const NEXT: Record<string, string> = {
      plan: "execute",
      execute: "verify",
      verify: "review",
      review: "accept",
    };
    return JSON.stringify({
      decision: "activate_next",
      reason: `link=${link} done (canned)`,
      next_link: NEXT[link] ?? "execute",
    });
  },
  commit_message: () => "chore(test): canned commit from FakeClaudeRunner",
  merge_decision: () =>
    JSON.stringify({
      decision: "merge",
      reason: "canned merge approval from FakeClaudeRunner",
    }),
};

/**
 * Detect which template was rendered by matching opener lines. Each
 * production template has a stable, distinct first or top-of-body
 * marker that's unaffected by variable substitution:
 *   - worker-decompose.md   → "Break down the requirement below..."
 *   - worker-evaluate.md    → "You just completed a task..."
 *   - worker-*-task.md      → "## Task to Execute" (all 5 role tasks)
 *   - worker-commit-message → "## Commit Task"
 */
function classifyPhase(prompt: string): FakePhase {
  if (/^Break down the requirement/m.test(prompt)) return "decompose";
  if (/^You just completed a task/m.test(prompt)) return "evaluate";
  if (/^## Commit Task/m.test(prompt)) return "commit_message";
  if (/^## Task to Execute/m.test(prompt)) return "worker_task";
  if (/^Branch `.+` has unmerged commits/m.test(prompt)) return "merge_decision";
  // Fallback: when none of the known markers match, treat the call as a
  // worker_task so a single text body is written. This keeps unknown
  // templates from silently dropping their output and producing a missing-
  // result.md retry storm.
  return "worker_task";
}

/**
 * Pull the role name out of the rendered identity prompt. The identity
 * card produced by `ClaudeRunner.buildIdentityPrompt` (runner.ts:24-33)
 * substitutes `{{role}}` literally, so a rendered line like
 * `You are Tom, a planner.` is reliable.
 */
function classifyRole(systemPrompt: string | undefined): string | null {
  if (!systemPrompt) return null;
  const m = systemPrompt.match(/You are\s+\S+,\s*(?:a|an)\s+([a-z]+)\./);
  if (m) return m[1];
  // personal-claude-<role>.md may also leave a role: <role> marker
  const m2 = systemPrompt.match(/role:\s*([a-z]+)/i);
  return m2?.[1] ?? null;
}

/**
 * Extract the absolute path the prompt instructed the model to write
 * its primary output to. Per-phase regex:
 *
 *   decompose: "Write the result to <path>. Also save a copy ..."
 *              (worker-decompose.md line 33)
 *   evaluate:  "Write to <path>." (worker-evaluate.md line 40)
 *   worker_task: "`{{result_path}}`" rendered → "`<path>`" line
 *                (worker-planner-task.md line 20, identical across roles)
 *
 * Returns null when no path can be found — caller treats that as a
 * non-fatal: log_path output is still written so the call is observable.
 */
function extractResultPath(phase: FakePhase, prompt: string): string | null {
  // All paths the orchestrator hands to claude end in `.md` (or `.result.md`
  // for evaluator). Anchoring on the extension avoids the non-greedy
  // `\S+?\.` pitfall where the regex stops at the first dot in the
  // path (e.g. `/tmp/.../.claude-orchestrator/...`).
  if (phase === "decompose") {
    const m = prompt.match(/Write the result to\s+(\S+?\.md)\b/);
    return m?.[1] ?? null;
  }
  if (phase === "evaluate") {
    const m = prompt.match(/Write to\s+(\S+?\.md)\b/);
    return m?.[1] ?? null;
  }
  if (phase === "worker_task") {
    // The result path appears on the line immediately after the
    // `result_path` literal label, indented and wrapped in backticks
    // (worker-planner-task.md:19-20 and identical layout in the other
    // four role task templates). Anchor on that label so we don't pick
    // up the earlier `original_requirement_path` (a `.md` path that
    // appears before `result_path` in the rendered prompt).
    const m = prompt.match(/`result_path`[^`]*?\n[^`\n]*`(\/[^\s`]+\.md)`/m);
    return m?.[1] ?? null;
  }
  return null;
}

/**
 * In-memory IClaudeRunner. See file-top trust justification.
 */
export class FakeClaudeRunner implements IClaudeRunner {
  private readonly invocations: InvocationRecord[];
  private readonly scripts: Record<FakePhase, PhaseScript>;
  private touchCounter = 0;

  constructor(private readonly opts: FakeClaudeRunnerOptions = {}) {
    this.scripts = {
      ...defaultScripts,
      ...(opts.scripts ?? {}),
    };
    this.invocations = opts.shared_invocations ?? [];
  }

  set_script(phase: FakePhase, fn: PhaseScript): void {
    this.scripts[phase] = fn;
  }

  get_invocations(): readonly InvocationRecord[] {
    return this.invocations;
  }

  count_by_phase(phase: FakePhase): number {
    return this.invocations.filter((r) => r.phase === phase).length;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const phase = classifyPhase(opts.prompt);
    const role = classifyRole(opts.system_prompt);
    const result_path = extractResultPath(phase, opts.prompt);
    const ctx: PhaseContext = {
      phase,
      role,
      prompt: opts.prompt,
      result_path,
      log_path: opts.log_path,
    };
    const body = this.scripts[phase](ctx);

    // Always materialize the log file so production code paths that
    // depend on its presence (commit-message reads first line, exit-code
    // logging) don't break. We write the *body* there too, so a phase
    // whose result_path can't be parsed still leaves a usable trail.
    await fs.promises.mkdir(path.dirname(opts.log_path), { recursive: true });
    await fs.promises.writeFile(opts.log_path, body + "\n", "utf-8");

    // For phases that have a separate result file, write the body there.
    // commit_message is the exception: CommitChecker reads from log_path.
    let output_path = opts.log_path;
    if (result_path && phase !== "commit_message") {
      await fs.promises.mkdir(path.dirname(result_path), { recursive: true });
      await fs.promises.writeFile(result_path, body, "utf-8");
      output_path = result_path;
    }

    // Pull out the upstream commit substitutions from the rendered prompt
    // for diagnostic logging. Template lines look like
    //   `- Plan: ` + backtick + `<sha>` + backtick
    // after substitution (e.g. worker-executor-task.md:19). An empty
    // string between backticks means upstream_commits was missing in the
    // dispatch message — a strong signal for §6.1 drift.
    const upstreamEcho = phase === "worker_task"
      ? Array.from(
          opts.prompt.matchAll(/- (Plan|Execute|Verify|Review|Accept): `([^`\n]*)`/g),
        ).map((m) => `${m[1].toLowerCase()}=${m[2] || "(empty)"}`).join(",")
      : "";

    const record: InvocationRecord = {
      phase,
      role,
      output_path,
      prompt_chars: opts.prompt.length,
      prompt_excerpt: opts.prompt.slice(0, 140).replace(/\s+/g, " "),
      upstream_echo: upstreamEcho,
    };
    this.invocations.push(record);

    // For worker_task phases, drop a marker file inside the worker's
    // worktree so CommitChecker.check finds a real change and produces
    // a non-null SHA. Without this, every link's commits.worktree would
    // be null and §9 item 4/5 assertions become trivially true.
    if (phase === "worker_task" && this.opts.worktree_path) {
      const dir = path.join(this.opts.worktree_path, ".co-test");
      await fs.promises.mkdir(dir, { recursive: true });
      const fileN = ++this.touchCounter;
      const file = path.join(dir, `${role ?? "task"}-${fileN}.md`);
      await fs.promises.writeFile(
        file,
        `# canned ${role ?? "task"} touch #${fileN}\n${body.slice(0, 200)}\n`,
        "utf-8",
      );
    }

    this.opts.on_after_write?.(record, ctx);

    return {
      exit_code: 0,
      session_id: asSessionId(randomUUID()),
      log_path: opts.log_path,
    };
  }
}
