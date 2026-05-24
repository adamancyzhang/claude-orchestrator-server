import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { asInstanceId } from "@co/contracts";

// ── Mock @co/infra: only execWithStreaming is faked; everything else is real ──
vi.mock("@co/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@co/infra")>();
  return { ...actual, execWithStreaming: vi.fn() };
});

import {
  execWithStreaming,
  loadConfig,
  loadProjectWorktreeConfig,
  type WorktreeEntry,
} from "@co/infra";
import { ClaudeRunner } from "../src/runner.js";
import { TemplateEngine } from "../src/template.js";

// ── Real project with complete .claude-orchestrator/config.json ──
const PROJECT_DIR = "/mnt/c/Users/adama/Documents/projects/test2";

// ── Template directory (from this repo) ──
const TEMPLATES_DIR = path.resolve(import.meta.dirname, "../../../templates");

// ── Lazy-loaded via beforeAll (process.cwd mock must be active first) ──
let CO_ROOT: string;
let WORKERS: (WorktreeEntry & {
  instance_id: ReturnType<typeof asInstanceId>;
  worktree_path: string;
})[] = [];
let originalCwd: () => string;

beforeAll(() => {
  originalCwd = process.cwd;
  process.cwd = () => PROJECT_DIR;

  const resolved = loadConfig();
  const entries = loadProjectWorktreeConfig();
  CO_ROOT = path.join(resolved.projects_root, resolved.instance_id!);
  WORKERS = Object.entries(entries).map(([_key, w]) => ({
    ...w,
    instance_id: asInstanceId(w.instance_id),
    worktree_path: path.join(PROJECT_DIR, w.path),
  }));
});

afterAll(() => {
  process.cwd = originalCwd;
});

// ── Reproduce child-boot.ts system-prompt assembly ──
const ROLE_TO_SYSTEM_TEMPLATE: Record<string, string> = {
  planner: "agents/planner/responsibilities.md",
  executor: "agents/executor/responsibilities.md",
  verifier: "agents/verifier/responsibilities.md",
  reviewer: "agents/reviewer/responsibilities.md",
  accepter: "agents/accepter/responsibilities.md",
  explorer: "agents/explorer/responsibilities.md",
};

function assembleSystemPrompt(opts: {
  name: string;
  role: string;
  worktree_path: string;
  branch: string;
  co_root: string;
  origin_branch?: string | null;
  agentsDir: string;
}): { prompt: string; parts: string[] } {
  const engine = new TemplateEngine({
    primary_dir: tmpdir(),
    fallback_dir: opts.agentsDir,
  });

  // Layer 1: agents/worker-identity.md
  if (!engine.has("agents/worker-identity.md")) {
    throw new Error("agents/worker-identity.md not found");
  }
  const identityTpl = engine.load("agents/worker-identity.md");

  // Layer 2: agents/{role}/responsibilities.md
  const roleTplName = ROLE_TO_SYSTEM_TEMPLATE[opts.role];
  if (!roleTplName) {
    throw new Error(`no role template mapping for role=${opts.role}`);
  }
  if (!engine.has(roleTplName)) {
    throw new Error(`${roleTplName} not found`);
  }
  const roleTpl = engine.load(roleTplName);

  const identityParts = [identityTpl, roleTpl].filter((s) => s.length > 0);

  const prompt = ClaudeRunner.buildIdentityPrompt(
    identityParts.join("\n\n---\n\n"),
    {
      name: opts.name,
      role: opts.role,
      origin_branch: opts.origin_branch ?? null,
      worktree_path: opts.worktree_path,
      worktree_branch: opts.branch,
      co_root: opts.co_root,
      co_role_path: path.join(opts.co_root, "docs", opts.name),
    },
  );

  return { prompt, parts: identityParts };
}

// ═══════════════════════════════════════════════════════════════
// Test 1: Per-worker system prompt + task prompt rendering
// ═══════════════════════════════════════════════════════════════

function renderTaskPrompt(w: (typeof WORKERS)[number]): string {
  const engine = new TemplateEngine({
    primary_dir: tmpdir(),
    fallback_dir: TEMPLATES_DIR,
  });
  const taskTplName = `agents/${w.role}/task.md`;
  if (!engine.has(taskTplName)) {
    throw new Error(`${taskTplName} not found`);
  }
  return engine.render(taskTplName, {
    task_title: `Example task for ${w.name}`,
    task_description: `This is the ${w.role} role executing its responsibility.`,
    task_criteria: "All acceptance criteria met",
    original_requirement_path: path.join(
      CO_ROOT, "chains", "chain-001", "requirement.md"),
    upstream_plan_artifact: path.join(
      CO_ROOT, "chains", "chain-001", "artifacts", "plan.md"),
    upstream_execute_artifact: path.join(
      CO_ROOT, "chains", "chain-001", "artifacts", "execute.md"),
    upstream_verify_artifact: path.join(
      CO_ROOT, "chains", "chain-001", "artifacts", "verify.md"),
    upstream_review_artifact: path.join(
      CO_ROOT, "chains", "chain-001", "artifacts", "review.md"),
    upstream_accept_artifact: path.join(
      CO_ROOT, "chains", "chain-001", "artifacts", "accept.md"),
    upstream_plan_commit: "abc123",
    upstream_execute_commit: "def456",
    upstream_verify_commit: "ghi789",
    upstream_review_commit: "jkl012",
    upstream_accept_commit: "mno345",
    local_doc_path: path.join(w.worktree_path, "docs", `${w.role}.md`),
    result_path: path.join(
      CO_ROOT, "chains", "chain-001", "artifacts", `${w.role}.md`),
    workspace_memory_path: path.join(CO_ROOT, "memory"),
    co_root: CO_ROOT,
    name: w.name,
    role: w.role,
    date: "2026-05-25",
    retry_hint: "",
    content: "",
    time: new Date().toISOString(),
    unique_key: "uuid-test-001",
    work_dir: w.worktree_path,
  });
}

function assertPromptClean(w: (typeof WORKERS)[number], systemPrompt: string, taskPrompt: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${w.name} — ${w.role}`);
  console.log(`${"=".repeat(60)}`);

  console.log(`\n-- System Prompt (--append-system-prompt) --`);
  console.log(`   chars: ${systemPrompt.length}`);
  console.log(systemPrompt);
  console.log();
  console.log(`-- Task Prompt (-p) --`);
  console.log(`   chars: ${taskPrompt.length}`);
  console.log(taskPrompt);
  console.log();

  expect(systemPrompt).toContain(w.name);
  expect(systemPrompt).toContain(w.role);
  expect(systemPrompt).not.toContain("{{name}}");
  expect(systemPrompt).not.toContain("{{role}}");
  expect(systemPrompt).not.toContain("{{worktreePath}}");
  expect(systemPrompt).not.toContain("{{worktreeBranch}}");
  expect(systemPrompt).not.toContain("{{originBranch}}");
  expect(systemPrompt).not.toContain("{{co_root}}");
  expect(systemPrompt).not.toContain("{{co_role_path}}");
  expect(systemPrompt.length).toBeGreaterThan(100);

  expect(taskPrompt).toContain(w.name);
  expect(taskPrompt).not.toContain("{{task_title}}");
  expect(taskPrompt).not.toContain("{{task_description}}");
  expect(taskPrompt).not.toContain("{{retry_hint}}");
  expect(taskPrompt.length).toBeGreaterThan(50);
}

describe("system prompt + task prompt", () => {
  function getWorker(name: string) {
    const w = WORKERS.find((w) => w.name === name);
    if (!w) throw new Error(`worker ${name} not found`);
    return w;
  }

  it("Tom (planner)", () => {
    const w = getWorker("Tom");
    const { prompt: systemPrompt } = assembleSystemPrompt({
      name: w.name, role: w.role, worktree_path: w.worktree_path,
      branch: w.branch, co_root: CO_ROOT, origin_branch: "master",
      agentsDir: TEMPLATES_DIR,
    });
    assertPromptClean(w, systemPrompt, renderTaskPrompt(w));
  });

  it("Jerry (executor)", () => {
    const w = getWorker("Jerry");
    const { prompt: systemPrompt } = assembleSystemPrompt({
      name: w.name, role: w.role, worktree_path: w.worktree_path,
      branch: w.branch, co_root: CO_ROOT, origin_branch: "master",
      agentsDir: TEMPLATES_DIR,
    });
    assertPromptClean(w, systemPrompt, renderTaskPrompt(w));
  });

  it("Lucy (verifier)", () => {
    const w = getWorker("Lucy");
    const { prompt: systemPrompt } = assembleSystemPrompt({
      name: w.name, role: w.role, worktree_path: w.worktree_path,
      branch: w.branch, co_root: CO_ROOT, origin_branch: "master",
      agentsDir: TEMPLATES_DIR,
    });
    assertPromptClean(w, systemPrompt, renderTaskPrompt(w));
  });

  it("Thomas (reviewer)", () => {
    const w = getWorker("Thomas");
    const { prompt: systemPrompt } = assembleSystemPrompt({
      name: w.name, role: w.role, worktree_path: w.worktree_path,
      branch: w.branch, co_root: CO_ROOT, origin_branch: "master",
      agentsDir: TEMPLATES_DIR,
    });
    assertPromptClean(w, systemPrompt, renderTaskPrompt(w));
  });

  it("Jack (accepter)", () => {
    const w = getWorker("Jack");
    const { prompt: systemPrompt } = assembleSystemPrompt({
      name: w.name, role: w.role, worktree_path: w.worktree_path,
      branch: w.branch, co_root: CO_ROOT, origin_branch: "master",
      agentsDir: TEMPLATES_DIR,
    });
    assertPromptClean(w, systemPrompt, renderTaskPrompt(w));
  });

  it("Lisa (executor)", () => {
    const w = getWorker("Lisa");
    const { prompt: systemPrompt } = assembleSystemPrompt({
      name: w.name, role: w.role, worktree_path: w.worktree_path,
      branch: w.branch, co_root: CO_ROOT, origin_branch: "master",
      agentsDir: TEMPLATES_DIR,
    });
    assertPromptClean(w, systemPrompt, renderTaskPrompt(w));
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 2: Role-template cross-validation
// ═══════════════════════════════════════════════════════════════

const EXPECTED_ROLE_LABEL: Record<string, string> = {
  planner: "Planner",
  executor: "Executor",
  verifier: "Verifier",
  reviewer: "Reviewer",
  accepter: "Accepter",
  explorer: "Explorer",
};

const EXPECTED_UPSTREAM_COUNT: Record<string, number> = {
  planner: 0,
  executor: 1,
  verifier: 2,
  reviewer: 3,
  accepter: 4,
  explorer: 5,
};

describe("role responsibilities cross-validation", () => {
  const engine = new TemplateEngine({
    primary_dir: tmpdir(),
    fallback_dir: TEMPLATES_DIR,
  });

  for (const [role, tplName] of Object.entries(ROLE_TO_SYSTEM_TEMPLATE)) {
    it(`${tplName} self-identifies as "${EXPECTED_ROLE_LABEL[role]}"`, () => {
      const body = engine.load(tplName);
      const label = EXPECTED_ROLE_LABEL[role];
      expect(body).toContain(`## Your Role: ${label}`);

      for (const [otherRole, otherLabel] of Object.entries(
        EXPECTED_ROLE_LABEL,
      )) {
        if (otherRole === role) continue;
        expect(body).not.toMatch(new RegExp(`## Your Role: ${otherLabel}`));
      }
    });

    it(`${tplName} declares correct chain position`, () => {
      const body = engine.load(tplName);
      if (role === "explorer") {
        expect(body).toContain("Explore responsibility chain");
      } else {
        expect(body).toContain("responsibility chain");
      }
    });

    it(`${tplName} mentions correct number of upstream artifacts`, () => {
      const body = engine.load(tplName);
      const upstreamCount = EXPECTED_UPSTREAM_COUNT[role];

      const upstreamArtifacts = [
        "upstream_plan_artifact",
        "upstream_execute_artifact",
        "upstream_verify_artifact",
        "upstream_review_artifact",
        "upstream_accept_artifact",
      ];

      let mentionedCount = 0;
      for (let i = 0; i < upstreamCount; i++) {
        if (body.includes(upstreamArtifacts[i])) mentionedCount++;
      }
      if (upstreamCount > 0) {
        expect(mentionedCount).toBeGreaterThanOrEqual(upstreamCount - 1);
      }
    });

    it(`${tplName} has no unresolved {{placeholders}} after rendering`, () => {
      const body = engine.load(tplName);
      const rendered = ClaudeRunner.buildIdentityPrompt(body, {
        name: "test-worker",
        role,
        origin_branch: "main",
        worktree_path: "/tmp/wt/test",
        worktree_branch: "test-branch",
        co_root: "/tmp/co/leader-123",
        co_role_path: "/tmp/co/leader-123/docs/test-worker",
      });
      expect(rendered).not.toContain("{{name}}");
      expect(rendered).not.toContain("{{role}}");
      expect(rendered).not.toContain("{{originBranch}}");
      expect(rendered).not.toContain("{{worktreePath}}");
      expect(rendered).not.toContain("{{worktreeBranch}}");
      expect(rendered).not.toContain("{{co_root}}");
      expect(rendered).not.toContain("{{co_role_path}}");
    });
  }

  it("all roles have both a responsibilities and a task template", () => {
    for (const [role, tplName] of Object.entries(ROLE_TO_SYSTEM_TEMPLATE)) {
      expect(engine.has(tplName), `${tplName} missing`).toBe(true);
      const taskTplName = `agents/${role}/task.md`;
      expect(engine.has(taskTplName), `${taskTplName} missing`).toBe(true);
    }
  });

  it("no role template cross-references another role's skill", () => {
    const SKILL_MAP: Record<string, string> = {
      planner: "task-planning",
      executor: "task-execution",
      verifier: "task-verification",
      reviewer: "task-review",
      accepter: "task-acceptance",
      explorer: "task-exploration",
    };

    for (const [role, tplName] of Object.entries(ROLE_TO_SYSTEM_TEMPLATE)) {
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
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 3: buildIdentityPrompt includes origin_branch
// ═══════════════════════════════════════════════════════════════

describe("ClaudeRunner.buildIdentityPrompt()", () => {
  it("interpolates co_role_path and originBranch", () => {
    const template = "CO: {{co_root}} Role: {{co_role_path}} Origin: {{originBranch}}";
    const result = ClaudeRunner.buildIdentityPrompt(template, {
      name: "worker-3",
      role: "executor",
      origin_branch: "main",
      worktree_path: "/tmp/wt",
      worktree_branch: "feature/foo",
      co_root: "/tmp/co",
      co_role_path: "/tmp/co/docs/worker-3",
    });

    expect(result).toBe("CO: /tmp/co Role: /tmp/co/docs/worker-3 Origin: main");
  });

  it("empty origin_branch renders as empty string", () => {
    const template = "Origin: {{originBranch}}.";
    const result = ClaudeRunner.buildIdentityPrompt(template, {
      name: "w",
      role: "planner",
      origin_branch: null,
      worktree_path: "/tmp",
      worktree_branch: "b",
      co_root: "/tmp",
      co_role_path: "/tmp/docs/w",
    });

    expect(result).toBe("Origin: .");
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 4: End-to-end ClaudeRunner invocation with real config
// ═══════════════════════════════════════════════════════════════

describe("ClaudeRunner.run() with real config", () => {
  it("Tom (planner): captures full CLI params", async () => {
    vi.mocked(execWithStreaming).mockResolvedValue({
      exit_code: 0,
      session_id: "sess-tom-001",
    });

    const tom = WORKERS[0];
    const { prompt: systemPrompt } = assembleSystemPrompt({
      name: tom.name,
      role: tom.role,
      worktree_path: tom.worktree_path,
      branch: tom.branch,
      co_root: CO_ROOT,
      origin_branch: "master",
      agentsDir: TEMPLATES_DIR,
    });

    const engine = new TemplateEngine({
      primary_dir: tmpdir(),
      fallback_dir: TEMPLATES_DIR,
    });
    const taskPrompt = engine.render("agents/planner/task.md", {
      task_title: "Build user authentication system",
      task_description: "Design auth system with login, register, and JWT",
      task_criteria: "Blueprint covers all flows, architecture, interfaces",
      original_requirement_path: path.join(
        CO_ROOT, "chains", "chain-001", "requirement.md"),
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
      local_doc_path: path.join(tom.worktree_path, "docs", "plan.md"),
      result_path: path.join(
        CO_ROOT, "chains", "chain-001", "artifacts", "plan.md"),
      workspace_memory_path: path.join(CO_ROOT, "memory"),
      co_root: CO_ROOT,
      name: tom.name,
      role: tom.role,
      date: "2026-05-24",
      retry_hint: "",
      content: "",
      time: new Date().toISOString(),
      unique_key: "uuid-plan-001",
      work_dir: tom.worktree_path,
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
      log_path: path.join(CO_ROOT, "tasks", "task-001", "exec-1.log"),
      system_prompt: systemPrompt,
      cwd: tom.worktree_path,
      quiet: true,
    });

    const opts = vi.mocked(execWithStreaming).mock.calls[0][0];

    console.log("\n════════════ FINAL CLI INVOCATION ════════════");
    console.log(`Worker      : ${tom.name} (${tom.role})`);
    console.log(`command     : ${opts.command}`);
    console.log(`cwd         : ${opts.cwd}`);
    console.log(`system_prompt: ${opts.system_prompt!.length} chars`);
    console.log(`user_prompt  : ${opts.prompt.length} chars`);
    console.log(`log_path     : ${opts.log_path}`);
    console.log("═══════════════════════════════════════════════\n");

    expect(opts.command).toBe("claude");
    expect(opts.cwd).toBe(tom.worktree_path);
    expect(opts.system_prompt).toBe(systemPrompt);
    expect(opts.prompt).toBe(taskPrompt);
    expect(opts.system_prompt!.length).toBeGreaterThan(500);
    expect(opts.prompt.length).toBeGreaterThan(100);
  });
});
