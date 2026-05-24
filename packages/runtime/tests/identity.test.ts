import { describe, it, expect, vi } from "vitest";
import * as path from "node:path";
import { tmpdir } from "node:os";

// Only mock the process-spawning boundary
vi.mock("@co/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@co/infra")>();
  return { ...actual, execWithStreaming: vi.fn() };
});

import { execWithStreaming } from "@co/infra";
import {
  buildWorkerSystemPrompt,
  renderDecomposePrompt,
  ROLE_TO_SYSTEM_TEMPLATE,
  TemplateEngine,
  ClaudeRunner,
} from "../src/index.js";

const TEMPLATES_DIR = path.resolve(import.meta.dirname, "../../../templates");

function createEngine(): TemplateEngine {
  return new TemplateEngine({
    primary_dir: path.join(TEMPLATES_DIR, "agents"),
    fallback_dir: TEMPLATES_DIR,
  });
}

// ═══════════════════════════════════════════════════════════════
// Test 1: buildWorkerSystemPrompt — real function, real templates
// ═══════════════════════════════════════════════════════════════

const SAMPLE_INPUT = {
  name: "Tom",
  role: "planner",
  origin_branch: "main",
  worktree_path: "/tmp/worktree/Tom",
  worktree_branch: "claude-orchestrator/Tom-workspace",
  co_root: "/tmp/co/leader-001",
  co_role_path: "/tmp/co/leader-001/docs/Tom",
};

describe("buildWorkerSystemPrompt", () => {
  it("returns a prompt containing worker name and role", () => {
    const engine = createEngine();
    const result = buildWorkerSystemPrompt(engine, SAMPLE_INPUT);

    console.log("\n" + "═".repeat(70));
    console.log("  buildWorkerSystemPrompt — Tom (planner)");
    console.log("═".repeat(70));
    console.log(result);
    console.log("═".repeat(70));

    expect(result).toContain("Tom");
    expect(result).toContain("Your Role: Planner");
    expect(result.length).toBeGreaterThan(100);
  });

  it("has no unresolved {{placeholders}}", () => {
    const engine = createEngine();
    const result = buildWorkerSystemPrompt(engine, SAMPLE_INPUT);

    expect(result).not.toContain("{{name}}");
    expect(result).not.toContain("{{role}}");
    expect(result).not.toContain("{{originBranch}}");
    expect(result).not.toContain("{{worktreePath}}");
    expect(result).not.toContain("{{worktreeBranch}}");
    expect(result).not.toContain("{{co_root}}");
    expect(result).not.toContain("{{co_role_path}}");
  });

  it("All 6 roles produce valid output", () => {
    const engine = createEngine();
    const roles = [
      { role: "planner", label: "Planner" },
      { role: "executor", label: "Executor" },
      { role: "verifier", label: "Verifier" },
      { role: "reviewer", label: "Reviewer" },
      { role: "accepter", label: "Accepter" },
      { role: "explorer", label: "Explorer" },
    ];

    for (const { role, label } of roles) {
      const result = buildWorkerSystemPrompt(engine, {
        ...SAMPLE_INPUT,
        role,
      });
      expect(result).toContain(SAMPLE_INPUT.name);
      expect(result).toContain(`## Your Role: ${label}`);
      expect(result).not.toContain("{{name}}");
      expect(result).not.toContain("{{role}}");
      expect(result.length).toBeGreaterThan(100);
    }
  });

  it("throws TemplateNotFoundError for unrecognized role", () => {
    const engine = createEngine();
    expect(() =>
      buildWorkerSystemPrompt(engine, {
        ...SAMPLE_INPUT,
        role: "nonexistent_role",
      }),
    ).toThrow("Template not found");
  });

  it("throws TemplateNotFoundError when identity template is missing", () => {
    // Empty primary_dir ensures no templates are found
    const engine = new TemplateEngine({ primary_dir: tmpdir() });
    expect(() =>
      buildWorkerSystemPrompt(engine, SAMPLE_INPUT),
    ).toThrow("Template not found: agents/worker-identity.md");
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 2: ROLE_TO_SYSTEM_TEMPLATE is complete
// ═══════════════════════════════════════════════════════════════

describe("ROLE_TO_SYSTEM_TEMPLATE", () => {
  it("covers all 6 expected roles", () => {
    expect(Object.keys(ROLE_TO_SYSTEM_TEMPLATE).sort()).toEqual([
      "accepter",
      "executor",
      "explorer",
      "planner",
      "reviewer",
      "verifier",
    ]);
  });

  it("all paths start with agents/", () => {
    for (const tplName of Object.values(ROLE_TO_SYSTEM_TEMPLATE)) {
      expect(tplName).toMatch(/^agents\/.+\/responsibilities\.md$/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 3: renderDecomposePrompt — real function, real template
// ═══════════════════════════════════════════════════════════════

describe("renderDecomposePrompt", () => {
  const sampleVars = {
    name: "Tom",
    role: "leader",
    task_title: "",
    task_description: "Add OAuth 2.0 GitHub login to user auth page",
    task_criteria: "",
    result_path: "/tmp/co/leader-001/messages/msg-001/decompose-result.md",
    work_dir: "/tmp/project",
    time: "2026-05-25T10:00:00Z",
    content: "Add OAuth 2.0 GitHub login to user auth page",
    co_root: "/tmp/co/leader-001",
    magic_mode: "false",
    magic_max_chains: "unlimited",
  };

  it("renders with no unresolved {{placeholders}}", () => {
    const engine = createEngine();
    const result = renderDecomposePrompt(engine, sampleVars);

    console.log("\n" + "═".repeat(70));
    console.log("  renderDecomposePrompt");
    console.log("═".repeat(70));
    console.log(result);
    console.log("═".repeat(70));

    expect(result).toContain(sampleVars.task_description);
    expect(result).not.toContain("{{");
  });

  it("magic_mode=true includes explore task instruction", () => {
    const engine = createEngine();
    const result = renderDecomposePrompt(engine, {
      ...sampleVars,
      magic_mode: "true",
    });

    expect(result).toContain("explore");
  });

  it("magic_mode=false does not include explore task instruction outside the JSON examples", () => {
    const engine = createEngine();
    const result = renderDecomposePrompt(engine, {
      ...sampleVars,
      magic_mode: "false",
    });

    // The instruction section says "MUST NOT include an explore task"
    expect(result).toContain("MUST NOT include an `explore` task");
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 4: Role responsibilities cross-validation (real templates)
// ═══════════════════════════════════════════════════════════════

const EXPECTED_ROLE_LABEL: Record<string, string> = {
  planner: "Planner",
  executor: "Executor",
  verifier: "Verifier",
  reviewer: "Reviewer",
  accepter: "Accepter",
  explorer: "Explorer",
};

const SKILL_MAP: Record<string, string> = {
  planner: "task-planning",
  executor: "task-execution",
  verifier: "task-verification",
  reviewer: "task-review",
  accepter: "task-acceptance",
  explorer: "task-exploration",
};

describe("role responsibilities template cross-validation", () => {
  const engine = createEngine();

  for (const [role, tplName] of Object.entries(ROLE_TO_SYSTEM_TEMPLATE)) {
    const label = EXPECTED_ROLE_LABEL[role];

    it(`${tplName} self-identifies as "${label}"`, () => {
      const body = engine.load(tplName);
      expect(body).toContain(`## Your Role: ${label}`);

      for (const [otherRole, otherLabel] of Object.entries(
        EXPECTED_ROLE_LABEL,
      )) {
        if (otherRole === role) continue;
        expect(body).not.toMatch(new RegExp(`## Your Role: ${otherLabel}`));
      }
    });

    it(`${tplName} references only its own skill (${SKILL_MAP[role]})`, () => {
      const body = engine.load(tplName);
      const ownSkill = SKILL_MAP[role];
      expect(body).toContain(ownSkill);

      for (const [otherRole, otherSkill] of Object.entries(SKILL_MAP)) {
        if (otherRole === role) continue;
        expect(
          body.includes(otherSkill),
          `${tplName} references ${otherSkill} (belongs to ${otherRole})`,
        ).toBe(false);
      }
    });
  }

  it("all templates exist and are non-empty", () => {
    for (const [role, tplName] of Object.entries(ROLE_TO_SYSTEM_TEMPLATE)) {
      expect(engine.has(tplName), `${tplName} missing`).toBe(true);
      const body = engine.load(tplName);
      expect(body.length).toBeGreaterThan(50);

      const taskTplName = `agents/${role}/task.md`;
      expect(engine.has(taskTplName), `${taskTplName} missing`).toBe(true);
      expect(engine.load(taskTplName).length).toBeGreaterThan(50);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 5: Runner integration — buildWorkerSystemPrompt + ClaudeRunner
// ═══════════════════════════════════════════════════════════════

describe("runner integration: system prompt + task prompt → execWithStreaming", () => {
  it("planner worker: execWithStreaming receives correct system_prompt and prompt", async () => {
    vi.mocked(execWithStreaming).mockResolvedValue({
      exit_code: 0,
      session_id: "sess-planner-001",
    });

    const engine = createEngine();
    const systemPrompt = buildWorkerSystemPrompt(engine, SAMPLE_INPUT);

    const taskPrompt = engine.render("agents/planner/task.md", {
      name: "Tom",
      role: "planner",
      date: "2026-05-25",
      unique_key: "uuid-plan-001",
      task_title: "OAuth 2.0 GitHub Login",
      task_description: "Add OAuth 2.0 GitHub third-party login support",
      task_criteria: "1. GitHub login button\n2. OAuth flow redirects\n3. User avatar displayed",
      result_path: "/tmp/co/leader-001/chains/chain-001/artifacts/plan.md",
      local_doc_path: "/tmp/worktree/Tom/docs/plan.md",
      work_dir: "/tmp/worktree/Tom",
      time: "2026-05-25T10:00:00Z",
      content: "",
      original_requirement_path: "/tmp/co/leader-001/chains/chain-001/requirement.md",
      upstream_plan_artifact: "",
      upstream_execute_artifact: "",
      upstream_verify_artifact: "",
      upstream_review_artifact: "",
      upstream_accept_artifact: "",
      upstream_plan_commit: "",
      upstream_execute_commit: "",
      upstream_verify_commit: "",
      upstream_review_commit: "",
      upstream_accept_commit: "",
      co_root: "/tmp/co/leader-001",
      workspace_memory_path: "/tmp/co/leader-001/memory",
      retry_hint: "",
    });

    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    const runner = new ClaudeRunner("claude", logger);

    await runner.run({
      prompt: taskPrompt,
      system_prompt: systemPrompt,
      log_path: "/tmp/logs/planner.log",
      cwd: "/tmp/worktree/Tom",
    });

    const call = vi.mocked(execWithStreaming).mock.calls.at(-1)![0];

    console.log("\n" + "═".repeat(70));
    console.log("  Runner integration: execWithStreaming received");
    console.log("═".repeat(70));
    console.log(`  command            : ${call.command}`);
    console.log(`  system_prompt (chars): ${call.system_prompt!.length}`);
    console.log(`  prompt (chars)     : ${call.prompt.length}`);
    console.log(`  cwd                : ${call.cwd}`);
    console.log("═".repeat(70));
    console.log("  Shell: claude --append-system-prompt '<sys>' -p '<prompt>'");

    expect(call.command).toBe("claude");
    expect(call.system_prompt).toBe(systemPrompt);
    expect(call.prompt).toBe(taskPrompt);
    expect(call.cwd).toBe("/tmp/worktree/Tom");
  });

  it("leader decompose: execWithStreaming receives NO system_prompt", async () => {
    vi.mocked(execWithStreaming).mockResolvedValue({
      exit_code: 0,
      session_id: "sess-decompose-001",
    });

    const engine = createEngine();
    const decomposePrompt = renderDecomposePrompt(engine, {
      name: "Tom",
      role: "leader",
      task_title: "",
      task_description: "Add OAuth 2.0 GitHub login",
      task_criteria: "",
      result_path: "/tmp/co/leader-001/messages/msg-001/decompose-result.md",
      work_dir: "/tmp/project",
      time: "2026-05-25T10:00:00Z",
      content: "Add OAuth 2.0 GitHub login",
      co_root: "/tmp/co/leader-001",
      magic_mode: "false",
      magic_max_chains: "unlimited",
    });

    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    const runner = new ClaudeRunner("claude", logger);

    await runner.run({
      prompt: decomposePrompt,
      log_path: "/tmp/logs/decompose.log",
    });

    const call = vi.mocked(execWithStreaming).mock.calls.at(-1)![0];

    console.log("\n" + "═".repeat(70));
    console.log("  Leader decompose: NO system_prompt");
    console.log("═".repeat(70));
    console.log(`  command            : ${call.command}`);
    console.log(`  system_prompt      : ${call.system_prompt ?? "(NONE)"}`);
    console.log(`  prompt (chars)     : ${call.prompt.length}`);

    expect(call.system_prompt).toBeUndefined();
    expect(call.prompt).toBe(decomposePrompt);
  });
});
