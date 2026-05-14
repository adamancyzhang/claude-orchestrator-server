// CORE-RETENTION
// Locks in: SelfEvaluator semantics — invokes ClaudeRunner with
//   `fork_session: true`, retries up to 3 times on parse failure with the
//   format-hint template appended on subsequent attempts, falls back to
//   activate_next/close_chain after MAX_RETRIES.
// Core path because: SelfEvaluator is the only authority for chain
//   progression decisions; a regression here either stalls chains or
//   activates the wrong next link.
// Owner subsystem: worker.
// Primary source files exercised:
//   - packages/worker/src/evaluator.ts
//
// TRUST-JUSTIFICATION: this test fakes IClaudeRunner so claude-cli is not
//   invoked.
// Downstream: real claude-cli execution is covered by
//   tests/core/manual/claude-cli-smoke.mjs in @co/runtime.
// Reason: claude-cli costs ~$0.10 and ~30s per call; unit tests must verify
//   evaluator's retry / fallback contract without that overhead.
// Evidence: the assertions check (a) fork_session is forwarded to runner,
//   (b) the format-hint is appended from attempt #2 onward, (c) the
//   fallback decision matches the design — exactly the protocol the real
//   runner would honor.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  asInstanceId,
  asTaskId,
  type IClaudeRunner,
  type ILogger,
  type RunOptions,
  type RunResult,
} from "@co/contracts";
import { TemplateEngine } from "@co/runtime";
import { SelfEvaluator } from "../../../src/index.js";

class FakeLogger implements ILogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): ILogger {
    return this;
  }
}

class RecordingRunner implements IClaudeRunner {
  calls: RunOptions[] = [];
  constructor(private readonly write: (path: string) => string | null) {}
  async run(opts: RunOptions): Promise<RunResult> {
    this.calls.push({ ...opts });
    fs.mkdirSync(path.dirname(opts.log_path), { recursive: true });
    const resultPath = `${opts.log_path}.result.md`;
    const payload = this.write(opts.log_path);
    if (payload !== null) {
      fs.writeFileSync(resultPath, payload);
    }
    return {
      exit_code: 0,
      session_id: null,
      log_path: opts.log_path,
    };
  }
}

function makeTemplateEngine(body?: string): TemplateEngine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-tpl-"));
  fs.writeFileSync(
    path.join(dir, "worker-evaluate.md"),
    body ?? "evaluate {{link}} {{result_path}}",
  );
  fs.writeFileSync(
    path.join(dir, "worker-evaluate-format-hint.md"),
    "FORMAT_HINT",
  );
  return new TemplateEngine({ primary_dir: dir });
}

function evaluatorWith(
  runner: IClaudeRunner,
  template_engine: TemplateEngine = makeTemplateEngine(),
): SelfEvaluator {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eval-cache-"));
  return new SelfEvaluator({
    runner,
    template_engine,
    logger: new FakeLogger(),
    cache_paths: {
      cache_dir: tmp,
      leader_instance_id: asInstanceId("leader1"),
    },
    worktree_path: "/wt",
    identity_system_prompt: "id",
    worker_name: "Tom",
    worker_role: "planner",
  });
}

describe("SelfEvaluator", () => {
  it("succeeds on first attempt with valid EvalDecision JSON", async () => {
    const runner = new RecordingRunner(() =>
      JSON.stringify({
        decision: "activate_next",
        reason: "ok",
        next_link: "build",
      }),
    );
    const evalr = evaluatorWith(runner);
    const out = await evalr.evaluate({
      link: "plan",
      task_id: asTaskId("t-1"),
      msg_vars: {},
      task_result_path: "/r/t-1.md",
    });
    const parsed = JSON.parse(out);
    expect(parsed.decision).toBe("activate_next");
    expect(parsed.next_link).toBe("build");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].fork_session).toBe(true);
    // First attempt prompt does NOT contain the format-hint
    expect(runner.calls[0].prompt.includes("FORMAT_HINT")).toBe(false);
  });

  it("retries on parse failure and appends format-hint from attempt 2", async () => {
    let attempt = 0;
    const runner = new RecordingRunner(() => {
      attempt++;
      if (attempt < 3) return "not json at all";
      return JSON.stringify({
        decision: "close_chain",
        reason: "done",
      });
    });
    const evalr = evaluatorWith(runner);
    const out = await evalr.evaluate({
      link: "accept",
      task_id: asTaskId("t-2"),
      msg_vars: {},
      task_result_path: "/r/t-2.md",
    });
    expect(JSON.parse(out).decision).toBe("close_chain");
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[0].prompt.includes("FORMAT_HINT")).toBe(false);
    expect(runner.calls[1].prompt.includes("FORMAT_HINT")).toBe(true);
    expect(runner.calls[2].prompt.includes("FORMAT_HINT")).toBe(true);
  });

  it("falls back to activate_next when all attempts fail (non-accept link)", async () => {
    const runner = new RecordingRunner(() => "junk");
    const evalr = evaluatorWith(runner);
    const out = await evalr.evaluate({
      link: "plan",
      task_id: asTaskId("t-3"),
      msg_vars: {},
      task_result_path: "/r/t-3.md",
    });
    const parsed = JSON.parse(out);
    expect(parsed.decision).toBe("activate_next");
    expect(parsed.next_link).toBe("build");
    expect(runner.calls).toHaveLength(3);
  });

  it("falls back to close_chain when accept fails 3 times", async () => {
    const runner = new RecordingRunner(() => "");
    const evalr = evaluatorWith(runner);
    const out = await evalr.evaluate({
      link: "accept",
      task_id: asTaskId("t-4"),
      msg_vars: {},
      task_result_path: "/r/t-4.md",
    });
    expect(JSON.parse(out).decision).toBe("close_chain");
  });

  it("substitutes {{name}} and {{role}} into the evaluate prompt", async () => {
    const runner = new RecordingRunner(() =>
      JSON.stringify({
        decision: "activate_next",
        reason: "ok",
        next_link: "build",
      }),
    );
    const tpl = makeTemplateEngine("hello {{name}} ({{role}}) at {{link}}");
    const evalr = evaluatorWith(runner, tpl);
    await evalr.evaluate({
      link: "plan",
      task_id: asTaskId("t-name"),
      msg_vars: {},
      task_result_path: "/r/t-name.md",
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].prompt).toContain("hello Tom (planner) at plan");
    expect(runner.calls[0].prompt).not.toContain("{{name}}");
    expect(runner.calls[0].prompt).not.toContain("{{role}}");
  });
});
