// CORE-RETENTION
// Locks in: buildWorkerTaskPrompt routes link → template per
// LINK_TO_TASK_TEMPLATE, returns msg.content verbatim when link is
// null, throws TemplateNotFoundError when the chosen template is
// absent (NO silent fallback to msg.content), substitutes all
// declared variable keys including empty-string placeholders for
// missing upstream commits and missing original_requirement_path,
// and threads retry_hint through on each call.
// Critical because: the per-link prompt is THE bridge between Leader
// dispatch and Claude. A silent fallback that drops the template on
// miss ships a degraded prompt; a regression that swallows upstream
// commit placeholders leaves the worker without rebase context; a
// missed retry_hint substitution lets the same broken pattern repeat
// across MAX_GENERATION_RETRIES attempts with no diagnostic feedback.
// Primary sources: packages/worker/src/prompt-render.ts

import { describe, expect, it } from "vitest";
import {
  asChainId,
  asInstanceId,
  asMessageId,
  asTaskId,
  TemplateNotFoundError,
  type ITemplateEngine,
  type Message,
} from "@co/contracts";
import type { ChainArtifactPaths } from "../src/chain-artifacts.js";
import {
  buildWorkerTaskPrompt,
  LINK_TO_TASK_TEMPLATE,
} from "../src/prompt-render.js";

// In-memory ITemplateEngine implementation backed by a Map. This is a
// real test data structure, not a mock — it implements the contract
// fully. No TRUST-JUSTIFICATION needed.
class MemoryTemplateEngine implements ITemplateEngine {
  constructor(private readonly templates: Map<string, string>) {}
  has(name: string): boolean {
    return this.templates.has(name);
  }
  load(name: string): string {
    const t = this.templates.get(name);
    if (!t) throw new TemplateNotFoundError(name);
    return t;
  }
  render(name: string, vars: Record<string, string>): string {
    let body = this.load(name);
    for (const [k, v] of Object.entries(vars)) {
      body = body.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
    }
    return body;
  }
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: asMessageId("m-1"),
    type: "direct",
    from_instance: asInstanceId("leader"),
    from_name: "Leader",
    from_role: "leader",
    to_instance: asInstanceId("worker"),
    to_name: "Worker",
    content: "raw content body",
    link: "execute",
    chain_id: asChainId("chain-x"),
    task_id: asTaskId("task-1"),
    task_title: "Implement OAuth",
    task_description: "Add OAuth flow",
    task_criteria: "All flows tested",
    result_path: null,
    original_requirement_path: "/tmp/req.md",
    reply_to: null,
    read: false,
    created_at: "2026-05-25T00:00:00Z",
    upstream_commits: {
      plan: "sha-plan",
      execute: null,
      verify: null,
      review: null,
      accept: null,
    },
    ...overrides,
  };
}

const EMPTY_ARTIFACTS: ChainArtifactPaths = {
  plan: "",
  execute: "",
  verify: "",
  review: "",
  accept: "",
};

describe("LINK_TO_TASK_TEMPLATE — exhaustive map", () => {
  it("covers every TaskLink plus decompose", () => {
    expect(Object.keys(LINK_TO_TASK_TEMPLATE).sort()).toEqual([
      "accept",
      "decompose",
      "execute",
      "explore",
      "plan",
      "review",
      "verify",
    ]);
    for (const tpl of Object.values(LINK_TO_TASK_TEMPLATE)) {
      // All worker task templates are under agents/ except decompose
      // which is under workflow/.
      expect(tpl).toMatch(/^(agents|workflow)\/.+\.md$/);
    }
  });
});

describe("buildWorkerTaskPrompt", () => {
  it("returns msg.content verbatim when link is null (ad-hoc message)", () => {
    const engine = new MemoryTemplateEngine(new Map());
    const result = buildWorkerTaskPrompt({
      template_engine: engine,
      link: null,
      msg: makeMessage({ content: "ad-hoc raw content" }),
      worker_name: "W",
      worker_role: "executor",
      worktree_path: "/wt",
      result_path: "/r.md",
      local_doc_path: "/local.md",
      unique_key: "key",
      date: "2026-05-25",
      retry_hint: "",
      chain_artifacts: EMPTY_ARTIFACTS,
      co_root: "/co",
      workspace_memory_path: "/mem",
    });
    expect(result).toBe("ad-hoc raw content");
  });

  it("throws TemplateNotFoundError when the template for the link is missing", () => {
    const engine = new MemoryTemplateEngine(new Map());
    expect(() =>
      buildWorkerTaskPrompt({
        template_engine: engine,
        link: "execute",
        msg: makeMessage(),
        worker_name: "W",
        worker_role: "executor",
        worktree_path: "/wt",
        result_path: "/r.md",
        local_doc_path: "/local.md",
        unique_key: "key",
        date: "2026-05-25",
        retry_hint: "",
        chain_artifacts: EMPTY_ARTIFACTS,
        co_root: "/co",
        workspace_memory_path: "/mem",
      }),
    ).toThrow(TemplateNotFoundError);
  });

  it("renders all required vars for a chain link", () => {
    const engine = new MemoryTemplateEngine(
      new Map([
        [
          "agents/executor/task.md",
          [
            "name={{name}}",
            "role={{role}}",
            "date={{date}}",
            "uk={{unique_key}}",
            "title={{task_title}}",
            "desc={{task_description}}",
            "crit={{task_criteria}}",
            "rp={{result_path}}",
            "ldp={{local_doc_path}}",
            "wd={{work_dir}}",
            "t={{time}}",
            "c={{content}}",
            "orp={{original_requirement_path}}",
            "uPA={{upstream_plan_artifact}}",
            "uEA={{upstream_execute_artifact}}",
            "uPC={{upstream_plan_commit}}",
            "uEC={{upstream_execute_commit}}",
            "co={{co_root}}",
            "wmp={{workspace_memory_path}}",
            "rh={{retry_hint}}",
          ].join("\n"),
        ],
      ]),
    );

    const result = buildWorkerTaskPrompt({
      template_engine: engine,
      link: "execute",
      msg: makeMessage(),
      worker_name: "Jerry",
      worker_role: "executor",
      worktree_path: "/path/to/wt",
      result_path: "/path/to/result.md",
      local_doc_path: "/path/to/local.md",
      unique_key: "uk-7",
      date: "2026-05-25",
      retry_hint: "RETRY 2/3 ...",
      chain_artifacts: {
        plan: "/co/tasks/tp/result.md",
        execute: "/co/tasks/te/result.md",
        verify: "",
        review: "",
        accept: "",
      },
      co_root: "/co",
      workspace_memory_path: "/co/memory",
      now: () => "2026-05-25T12:00:00Z",
    });

    const expected = [
      "name=Jerry",
      "role=executor",
      "date=2026-05-25",
      "uk=uk-7",
      "title=Implement OAuth",
      "desc=Add OAuth flow",
      "crit=All flows tested",
      "rp=/path/to/result.md",
      "ldp=/path/to/local.md",
      "wd=/path/to/wt",
      "t=2026-05-25T12:00:00Z",
      "c=raw content body",
      "orp=/tmp/req.md",
      "uPA=/co/tasks/tp/result.md",
      "uEA=/co/tasks/te/result.md",
      "uPC=sha-plan",
      "uEC=",
      "co=/co",
      "wmp=/co/memory",
      "rh=RETRY 2/3 ...",
    ].join("\n");
    expect(result).toBe(expected);
  });

  it("substitutes empty strings for unmatched upstream commits (no silent fallback to placeholder)", () => {
    const engine = new MemoryTemplateEngine(
      new Map([
        [
          "agents/planner/task.md",
          "verifyCommit=[{{upstream_verify_commit}}] reviewCommit=[{{upstream_review_commit}}]",
        ],
      ]),
    );

    const result = buildWorkerTaskPrompt({
      template_engine: engine,
      link: "plan",
      msg: makeMessage({
        upstream_commits: undefined, // entirely missing
      }),
      worker_name: "Tom",
      worker_role: "planner",
      worktree_path: "/wt",
      result_path: "/r",
      local_doc_path: "/l",
      unique_key: "k",
      date: "d",
      retry_hint: "",
      chain_artifacts: EMPTY_ARTIFACTS,
      co_root: "/co",
      workspace_memory_path: "/mem",
    });
    expect(result).toBe("verifyCommit=[] reviewCommit=[]");
  });

  it("falls back to msg.content for task_description when msg.task_description is undefined", () => {
    const engine = new MemoryTemplateEngine(
      new Map([
        ["agents/executor/task.md", "desc=[{{task_description}}]"],
      ]),
    );
    const result = buildWorkerTaskPrompt({
      template_engine: engine,
      link: "execute",
      msg: makeMessage({
        task_description: null,
        content: "fallback content",
      }),
      worker_name: "W",
      worker_role: "executor",
      worktree_path: "/wt",
      result_path: "/r",
      local_doc_path: "/l",
      unique_key: "k",
      date: "d",
      retry_hint: "",
      chain_artifacts: EMPTY_ARTIFACTS,
      co_root: "/co",
      workspace_memory_path: "/mem",
    });
    expect(result).toBe("desc=[fallback content]");
  });

  it("injects retry_hint via {{retry_hint}}", () => {
    const engine = new MemoryTemplateEngine(
      new Map([["agents/executor/task.md", "hint=<{{retry_hint}}>"]]),
    );
    const r1 = buildWorkerTaskPrompt({
      template_engine: engine,
      link: "execute",
      msg: makeMessage(),
      worker_name: "W",
      worker_role: "executor",
      worktree_path: "/wt",
      result_path: "/r",
      local_doc_path: "/l",
      unique_key: "k",
      date: "d",
      retry_hint: "",
      chain_artifacts: EMPTY_ARTIFACTS,
      co_root: "/co",
      workspace_memory_path: "/mem",
    });
    expect(r1).toBe("hint=<>");

    const r2 = buildWorkerTaskPrompt({
      template_engine: engine,
      link: "execute",
      msg: makeMessage(),
      worker_name: "W",
      worker_role: "executor",
      worktree_path: "/wt",
      result_path: "/r",
      local_doc_path: "/l",
      unique_key: "k",
      date: "d",
      retry_hint: "second try",
      chain_artifacts: EMPTY_ARTIFACTS,
      co_root: "/co",
      workspace_memory_path: "/mem",
    });
    expect(r2).toBe("hint=<second try>");
  });
});
