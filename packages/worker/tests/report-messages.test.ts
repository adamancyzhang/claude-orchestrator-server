// CORE-RETENTION
// Locks in: report-messages.ts builders + senders contract.
// buildCompletionBody returns evaluator output verbatim when no commit
// and no docsSha; merges `commits` + `commit` fields into JSON when
// evaluator returned JSON; falls back to plain-text tag appending when
// evaluator did not return JSON. buildForcedFeedbackDecision returns a
// JSON-serializable feedback decision with feedback_target = self and
// the stderr-derived reason truncated to 200 chars. The async senders
// pass the right payload to the router (correct type, from/to, body,
// link, task_id, chain_id, result_path) and forward msg.chain_id as
// null when absent. sendDecomposeReport reads the result file from
// disk and uses its bytes as the body.
// Critical because: the leader's chain-router pattern-matches on the
// message envelope and JSON shape — a regression in the field order,
// the field names, or the `commits` vs `commit` invariant silently
// breaks chain advancement (close_chain proceeds without our link's
// commit) or memory_refresh dispatch.
// Primary sources: packages/worker/src/report-messages.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  asChainId,
  asInstanceId,
  asMessageId,
  asTaskId,
  type Message,
  type SendMessageInput,
} from "@co/contracts";
import type { CommitResult } from "../src/commit-checker.js";
import {
  buildCompletionBody,
  buildForcedFeedbackDecision,
  sendCompletionReport,
  sendDecomposeReport,
  sendForcedFeedbackReport,
  type WorkerIdentity,
} from "../src/report-messages.js";
import type { QualityGateResult } from "../src/quality-gate.js";

const IDENTITY: WorkerIdentity = {
  instance_id: asInstanceId("worker-x"),
  worker_name: "WorkerX",
  worker_role: "executor",
  worktree_branch: "claude-orchestrator/WorkerX-workspace",
  leader_id: asInstanceId("leader"),
};

// TRUST-JUSTIFICATION: CapturingRouter is a fake { send } implementation
// — the boundary the send-report functions actually consume.
// Downstream: IMessageRouter.send writes a ZK node. Covered by
// coordination/tests/message-router.test.ts.
// Reason: report-messages.ts is the SUT. We want to observe the
// SendMessageInput the senders construct — that IS the contract.
// Evidence: the fake captures every send() call into an array so we
// can assert on observable inputs, not on call counts.
class CapturingRouter {
  public readonly sent: SendMessageInput[] = [];
  async send(input: SendMessageInput): Promise<Message> {
    this.sent.push(input);
    // Return value is unused by the senders, but Message shape is required.
    return {
      id: asMessageId(`m-${this.sent.length}`),
      type: input.type,
      from_instance: input.from_instance,
      from_name: input.from_name,
      from_role: input.from_role ?? "",
      to_instance: input.to_instance ?? asInstanceId("leader"),
      to_name: input.to_name ?? null,
      content: input.content,
      link: input.link ?? null,
      chain_id: input.chain_id ?? null,
      task_id: input.task_id ?? null,
      task_title: input.task_title ?? null,
      task_description: input.task_description ?? null,
      task_criteria: input.task_criteria ?? null,
      result_path: input.result_path ?? null,
      original_requirement_path: null,
      reply_to: null,
      read: false,
      created_at: "2026-05-25T00:00:00Z",
    };
  }
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: asMessageId("incoming"),
    type: "direct",
    from_instance: asInstanceId("leader"),
    from_name: "Leader",
    from_role: "leader",
    to_instance: IDENTITY.instance_id,
    to_name: IDENTITY.worker_name,
    content: "go",
    link: "execute",
    chain_id: asChainId("chain-1"),
    task_id: asTaskId("task-1"),
    task_title: "do it",
    task_description: "details",
    task_criteria: null,
    result_path: null,
    original_requirement_path: null,
    reply_to: null,
    read: false,
    created_at: "2026-05-25T00:00:00Z",
    ...overrides,
  };
}

describe("buildCompletionBody", () => {
  const commit: CommitResult = {
    sha: "deadbeefcafe1234567890abcdef1234567890ab",
    message: "feat: do something",
    changed_files: ["src/a.ts"],
    untracked_files: [],
  };

  it("returns evaluator content unchanged when no commit and no docsSha", () => {
    expect(
      buildCompletionBody({
        evalContent: '{"decision":"activate_next"}',
        commit: null,
        docsSha: null,
        worktreeBranch: "claude-orchestrator/X-workspace",
      }),
    ).toBe('{"decision":"activate_next"}');
  });

  it("merges commits + commit fields into JSON evaluator output", () => {
    const body = buildCompletionBody({
      evalContent: '{"decision":"activate_next","next_link":"verify"}',
      commit,
      docsSha: "1111111122222222333333334444444455555555",
      worktreeBranch: "claude-orchestrator/X-workspace",
    });
    const parsed = JSON.parse(body);
    expect(parsed.decision).toBe("activate_next");
    expect(parsed.next_link).toBe("verify");
    expect(parsed.commits).toEqual({
      worktree: commit.sha,
      docs: "1111111122222222333333334444444455555555",
      branch: "claude-orchestrator/X-workspace",
    });
    expect(parsed.commit).toEqual({
      sha: commit.sha,
      message: commit.message,
      branch: "claude-orchestrator/X-workspace",
      changed_files: commit.changed_files,
      untracked_files: commit.untracked_files,
    });
  });

  it("commits.worktree is null when no commit but docsSha exists", () => {
    const body = buildCompletionBody({
      evalContent: '{"decision":"activate_next"}',
      commit: null,
      docsSha: "abc1234567",
      worktreeBranch: "br",
    });
    const parsed = JSON.parse(body);
    expect(parsed.commits.worktree).toBeNull();
    expect(parsed.commits.docs).toBe("abc1234567");
    expect(parsed.commit).toBeUndefined();
  });

  it("falls back to plain-text tag appending when evaluator did not return JSON", () => {
    const body = buildCompletionBody({
      evalContent: "free-text evaluator output",
      commit,
      docsSha: "1111111122222222",
      worktreeBranch: "br",
    });
    expect(body.startsWith("free-text evaluator output")).toBe(true);
    expect(body).toContain(`Commit: ${commit.sha.slice(0, 7)} - ${commit.message}`);
    expect(body).toContain("Docs commit: 1111111");
  });

  it("merges quality_gate_result into JSON evaluator output when provided", () => {
    const gateResult: QualityGateResult = {
      passed: true,
      gate_type: "test",
      message: "all tests passed",
    };
    const body = buildCompletionBody({
      evalContent: '{"decision":"activate_next"}',
      commit: null,
      docsSha: null,
      worktreeBranch: "br",
      qualityGateResult: gateResult,
    });
    const parsed = JSON.parse(body);
    expect(parsed.quality_gate_result).toEqual({
      type: "test",
      passed: true,
      details: "all tests passed",
      requires_async: false,
    });
  });

  it("includes requires_async=true for review gates", () => {
    const gateResult: QualityGateResult = {
      passed: true,
      gate_type: "review",
      message: "Review pending: check architecture",
      requires_async: true,
    };
    const body = buildCompletionBody({
      evalContent: '{"decision":"activate_next"}',
      commit: null,
      docsSha: null,
      worktreeBranch: "br",
      qualityGateResult: gateResult,
    });
    const parsed = JSON.parse(body);
    expect(parsed.quality_gate_result.requires_async).toBe(true);
    expect(parsed.quality_gate_result.type).toBe("review");
  });

  it("omits quality_gate_result when not provided", () => {
    const body = buildCompletionBody({
      evalContent: '{"decision":"activate_next"}',
      commit: null,
      docsSha: null,
      worktreeBranch: "br",
    });
    const parsed = JSON.parse(body);
    expect(parsed.quality_gate_result).toBeUndefined();
  });

  it("merges quality_gate_result alongside commit fields", () => {
    const gateResult: QualityGateResult = {
      passed: false,
      gate_type: "test",
      message: "Command failed: npm test\nExit code: 1",
    };
    const body = buildCompletionBody({
      evalContent: '{"decision":"needs_revision"}',
      commit,
      docsSha: "abc123",
      worktreeBranch: "br",
      qualityGateResult: gateResult,
    });
    const parsed = JSON.parse(body);
    expect(parsed.commit).toBeDefined();
    expect(parsed.commits).toBeDefined();
    expect(parsed.quality_gate_result.passed).toBe(false);
    expect(parsed.quality_gate_result.details).toContain("Command failed");
  });
});

describe("buildForcedFeedbackDecision", () => {
  it("returns a feedback decision targeting the worker itself", () => {
    const decision = buildForcedFeedbackDecision({
      link: "execute",
      taskId: asTaskId("task-9"),
      instanceId: IDENTITY.instance_id,
      stderr: "fatal: cannot create commit",
    });
    expect(decision.decision).toBe("feedback");
    expect(decision.feedback_target).toBe(IDENTITY.instance_id);
    expect(decision.reason).toContain("commit failed at execute");
    expect(decision.reason).toContain("fatal: cannot create commit");
    expect(decision.feedback_to_worker).toContain("task-9");
  });

  it("truncates stderr to 200 chars in the reason", () => {
    const longStderr = "x".repeat(500);
    const decision = buildForcedFeedbackDecision({
      link: "verify",
      taskId: asTaskId("t-long"),
      instanceId: IDENTITY.instance_id,
      stderr: longStderr,
    });
    // The reason prefix is "commit failed at verify: " then up to 200 stderr chars.
    const reasonStderr = decision.reason.replace(/^commit failed at verify: /, "");
    expect(reasonStderr.length).toBeLessThanOrEqual(200);
  });

  it("uses 'unknown error' when stderr is empty", () => {
    const decision = buildForcedFeedbackDecision({
      link: "review",
      taskId: asTaskId("t-empty"),
      instanceId: IDENTITY.instance_id,
      stderr: "",
    });
    expect(decision.reason).toContain("unknown error");
  });
});

describe("sendCompletionReport", () => {
  it("sends completion_report with the correct envelope", async () => {
    const router = new CapturingRouter();
    const msg = makeMessage();

    await sendCompletionReport({
      router,
      identity: IDENTITY,
      link: "execute",
      msg,
      resultPath: "/tmp/result.md",
      taskId: asTaskId("task-1"),
      body: '{"decision":"activate_next"}',
    });

    expect(router.sent).toHaveLength(1);
    const sent = router.sent[0];
    expect(sent.type).toBe("completion_report");
    expect(sent.from_instance).toBe(IDENTITY.instance_id);
    expect(sent.from_name).toBe(IDENTITY.worker_name);
    expect(sent.from_role).toBe(IDENTITY.worker_role);
    expect(sent.to_instance).toBe(IDENTITY.leader_id);
    expect(sent.content).toBe('{"decision":"activate_next"}');
    expect(sent.link).toBe("execute");
    expect(sent.task_id).toBe(asTaskId("task-1"));
    expect(sent.chain_id).toBe(asChainId("chain-1"));
    expect(sent.result_path).toBe("/tmp/result.md");
  });

  it("forwards chain_id as null when the message has no chain_id", async () => {
    const router = new CapturingRouter();
    await sendCompletionReport({
      router,
      identity: IDENTITY,
      link: "plan",
      msg: makeMessage({ chain_id: null }),
      resultPath: "/tmp/r.md",
      taskId: asTaskId("task-x"),
      body: "body",
    });
    expect(router.sent[0].chain_id).toBeNull();
  });
});

describe("sendForcedFeedbackReport", () => {
  it("sends completion_report whose JSON body is the feedback decision", async () => {
    const router = new CapturingRouter();
    await sendForcedFeedbackReport({
      router,
      identity: IDENTITY,
      link: "execute",
      msg: makeMessage(),
      resultPath: "/tmp/r.md",
      taskId: asTaskId("task-7"),
      stderr: "git push failed: permission denied",
    });

    expect(router.sent).toHaveLength(1);
    const sent = router.sent[0];
    expect(sent.type).toBe("completion_report");
    expect(sent.link).toBe("execute");
    expect(sent.task_id).toBe(asTaskId("task-7"));
    const parsed = JSON.parse(sent.content);
    expect(parsed.decision).toBe("feedback");
    expect(parsed.feedback_target).toBe(IDENTITY.instance_id);
    expect(parsed.reason).toContain("permission denied");
  });
});

describe("sendDecomposeReport", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "co-decompose-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reads the result file and sends its content as the body, link=null", async () => {
    const router = new CapturingRouter();
    const resultPath = path.join(tmpRoot, "decompose.md");
    fs.writeFileSync(resultPath, "decomposed task definitions here", "utf-8");

    await sendDecomposeReport({
      router,
      identity: IDENTITY,
      msg: makeMessage(),
      resultPath,
      taskId: asTaskId("task-decompose"),
    });

    expect(router.sent).toHaveLength(1);
    const sent = router.sent[0];
    expect(sent.type).toBe("completion_report");
    expect(sent.link).toBeNull();
    expect(sent.content).toBe("decomposed task definitions here");
    expect(sent.task_id).toBe(asTaskId("task-decompose"));
    expect(sent.result_path).toBe(resultPath);
  });
});
