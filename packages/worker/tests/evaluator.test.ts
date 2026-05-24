// CORE-RETENTION
// Locks in: chainLinksFor toggles the explore link by magic_mode; SelfEvaluator
// renders the eval template, invokes the runner, parses the result file as
// EvalDecision JSON, and falls back to `reject` (never `activate_next`)
// after MAX_RETRIES schema failures.
// Critical because: the fallback contract is the chain's quality gate —
// a regression to `activate_next` on unparseable eval output would silently
// advance broken work past every link including accept.
// Primary sources: packages/worker/src/evaluator.ts

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  asInstanceId,
  asTaskId,
  cachePaths,
  type IClaudeRunner,
  type ILogger,
  type ITemplateEngine,
  type RunOptions,
  type RunResult,
} from "@co/contracts";
import { SelfEvaluator, chainLinksFor } from "../src/evaluator.js";

// ── chainLinksFor — pure table test ──────────────────────────────────

describe("chainLinksFor", () => {
  it("returns the canonical 5 default links without magic_mode", () => {
    expect(chainLinksFor(false)).toEqual([
      "plan",
      "execute",
      "verify",
      "review",
      "accept",
    ]);
  });

  it("returns 6 links (default + explore) with magic_mode=true", () => {
    expect(chainLinksFor(true)).toEqual([
      "plan",
      "execute",
      "verify",
      "review",
      "accept",
      "explore",
    ]);
  });
});

// ── SelfEvaluator — runner stub + real fs result files ───────────────

let projectsRoot: string;
let leaderId: ReturnType<typeof asInstanceId>;
let taskId: ReturnType<typeof asTaskId>;

beforeEach(() => {
  projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "co-eval-"));
  leaderId = asInstanceId("leader-test");
  taskId = asTaskId("task-001");
});

afterEach(() => {
  fs.rmSync(projectsRoot, { recursive: true, force: true });
});

const SILENT_LOGGER: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => SILENT_LOGGER,
} as unknown as ILogger;

// TRUST-JUSTIFICATION: IClaudeRunner spawns the external `claude` CLI.
// Stub is an alternate IClaudeRunner implementation that writes a queued
// payload to the result path (`${log_path}.result.md`). This exercises
// SelfEvaluator's full fs.readFile + extractJson + Schema.parse path
// against real bytes — the only thing simulated is the CLI invocation
// itself. Evidence: the runner contract is exercised end-to-end by
// packages/runtime/tests/identity.test.ts.
function queuedRunner(payloads: readonly string[]): IClaudeRunner {
  let idx = 0;
  return {
    async run(opts: RunOptions): Promise<RunResult> {
      const payload = payloads[Math.min(idx, payloads.length - 1)];
      idx += 1;
      const resultPath = `${opts.log_path}.result.md`;
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(resultPath, payload, "utf-8");
      return { exit_code: 0, session_id: null, log_path: opts.log_path };
    },
  };
}

const STUB_TEMPLATE_ENGINE: ITemplateEngine = {
  has: () => true,
  load: () => "format hint",
  render: () => "prompt body",
};

function makeEvaluator(runner: IClaudeRunner): SelfEvaluator {
  return new SelfEvaluator({
    runner,
    template_engine: STUB_TEMPLATE_ENGINE,
    logger: SILENT_LOGGER,
    cache_paths: { projects_root: projectsRoot, leader_instance_id: leaderId },
    worktree_path: "/tmp/worktree",
    identity_system_prompt: "you are a tester",
    worker_name: "T",
    worker_role: "verifier",
  });
}

describe("SelfEvaluator.evaluate — first-attempt success", () => {
  it("returns the parsed EvalDecision JSON on the first parseable payload", async () => {
    const runner = queuedRunner([
      JSON.stringify({
        decision: "activate_next",
        reason: "ok",
        next_link: "review",
      }),
    ]);
    const ev = makeEvaluator(runner);

    const result = await ev.evaluate({
      link: "verify",
      task_id: taskId,
      msg_vars: {},
      task_result_path: "/tmp/result.md",
    });
    const parsed = JSON.parse(result) as {
      decision: string;
      next_link: string;
    };
    expect(parsed.decision).toBe("activate_next");
    expect(parsed.next_link).toBe("review");
  });
});

describe("SelfEvaluator.evaluate — retry after malformed payload", () => {
  it("retries on the first malformed payload and succeeds on a later good one", async () => {
    const runner = queuedRunner([
      "{not valid json",
      JSON.stringify({ decision: "close_chain", reason: "done" }),
    ]);
    const ev = makeEvaluator(runner);

    const result = await ev.evaluate({
      link: "accept",
      task_id: taskId,
      msg_vars: {},
      task_result_path: "/tmp/result.md",
    });
    expect(JSON.parse(result).decision).toBe("close_chain");
  });
});

describe("SelfEvaluator.evaluate — exhausted retries fall back to `reject`", () => {
  it("returns a reject decision (NEVER activate_next) after MAX_RETRIES schema failures", async () => {
    // Three consecutive unparseable payloads → fallback path.
    const runner = queuedRunner(["garbage", "still garbage", "more garbage"]);
    const ev = makeEvaluator(runner);

    const result = await ev.evaluate({
      link: "accept",
      task_id: taskId,
      msg_vars: {},
      task_result_path: "/tmp/result.md",
    });
    const parsed = JSON.parse(result) as { decision: string; reason: string };
    expect(parsed.decision).toBe("reject");
    expect(parsed.reason).toContain("self-evaluation failed");
    expect(parsed.reason).toContain("accept");
  });

  it("never silently advances on a schema-invalid (but JSON-valid) decision", async () => {
    const runner = queuedRunner([
      JSON.stringify({ decision: "destroy_everything", reason: "x" }),
      JSON.stringify({ decision: "destroy_everything", reason: "x" }),
      JSON.stringify({ decision: "destroy_everything", reason: "x" }),
    ]);
    const ev = makeEvaluator(runner);
    const result = await ev.evaluate({
      link: "verify",
      task_id: taskId,
      msg_vars: {},
      task_result_path: "/tmp/result.md",
    });
    expect(JSON.parse(result).decision).toBe("reject");
  });
});

describe("SelfEvaluator.evaluate — empty result file is treated as retry-eligible", () => {
  it("retries past an empty result file and parses the next attempt", async () => {
    const runner = queuedRunner([
      "",
      JSON.stringify({ decision: "reject", reason: "x" }),
    ]);
    const ev = makeEvaluator(runner);
    const result = await ev.evaluate({
      link: "verify",
      task_id: taskId,
      msg_vars: {},
      task_result_path: "/tmp/result.md",
    });
    expect(JSON.parse(result).decision).toBe("reject");
  });
});

describe("SelfEvaluator writes a distinct eval log per attempt", () => {
  it("creates eval-0/eval-1/eval-2 files corresponding to each attempt", async () => {
    const runner = queuedRunner([
      "bad1",
      "bad2",
      JSON.stringify({ decision: "reject", reason: "x" }),
    ]);
    const ev = makeEvaluator(runner);
    await ev.evaluate({
      link: "verify",
      task_id: taskId,
      msg_vars: {},
      task_result_path: "/tmp/result.md",
    });

    const eval0 = cachePaths.evalLogPath(
      { projects_root: projectsRoot, leader_instance_id: leaderId },
      taskId,
      0,
    );
    const eval2 = cachePaths.evalLogPath(
      { projects_root: projectsRoot, leader_instance_id: leaderId },
      taskId,
      2,
    );
    // The runner stub writes to `<log_path>.result.md`, so verify those
    // result files exist (a deterministic proof attempts ran).
    expect(fs.existsSync(`${eval0}.result.md`)).toBe(true);
    expect(fs.existsSync(`${eval2}.result.md`)).toBe(true);
  });
});
