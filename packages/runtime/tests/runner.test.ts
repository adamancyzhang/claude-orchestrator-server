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
import { buildWorkerSystemPrompt } from "../src/identity.js";

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

// ═══════════════════════════════════════════════════════════════
// Test 1: buildIdentityPrompt includes origin_branch
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
    const engine = new TemplateEngine({
      primary_dir: tmpdir(),
      fallback_dir: TEMPLATES_DIR,
    });
    const systemPrompt = buildWorkerSystemPrompt(engine, {
      name: tom.name,
      role: tom.role,
      origin_branch: "master",
      worktree_path: tom.worktree_path,
      worktree_branch: tom.branch,
      co_root: CO_ROOT,
      co_role_path: path.join(CO_ROOT, "docs", tom.name),
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

    const opts = vi.mocked(execWithStreaming).mock.calls.at(-1)![0];

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
