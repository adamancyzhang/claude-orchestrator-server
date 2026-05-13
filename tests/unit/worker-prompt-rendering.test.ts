import { describe, it, expect } from "vitest";
import { TemplateEngine } from "../../src/executor/template.js";
import * as path from "node:path";

const TEMPLATES_DIR = path.resolve(process.cwd(), "templates", "agents");

const TEST_VARS: Record<string, string> = {
  name: "TestWorker",
  preset_role: "builder",
  task_title: "Implement User Login API",
  task_description: "Build the user login endpoint with JWT authentication following the blueprint.",
  task_criteria: "curl -X POST /api/login returns 201 with a valid JWT token",
  task_doc_path: "/tmp/cache/leader-001/tasks/task-00001.md",
  result_path: "/tmp/cache/leader-001/results/task-00001-result.md",
  task_result_path: "/tmp/cache/leader-001/results/task-00001-result.md",
  work_dir: "/tmp/worktrees/TestWorker",
  time: "2026-05-13T10:00:00.000Z",
  content: "Build the user login endpoint",
  worktree_path: "/tmp/worktrees/TestWorker",
  worktree_branch: "co-worker-TestWorker",
  instance_id: "test1234",
  link: "build",
  daily_dir: ".claude-orchestrator/docs/TestWorker/2026-05-13",
  daily_claude: "",
};

function hasUnreplacedVars(text: string): string[] {
  const matches = text.match(/\{\{(\w+)\}\}/g);
  return matches ? [...new Set(matches)] : [];
}

describe("Worker Prompt Rendering", () => {
  const engine = new TemplateEngine(TEMPLATES_DIR);

  it("loads all link templates without error", async () => {
    await engine.loadAll();
    for (const link of ["plan", "build", "verify", "review", "accept", "decompose"]) {
      const tpl = engine.get(link);
      expect(tpl).toBeDefined();
      expect(tpl!.length).toBeGreaterThan(0);
    }
  });

  it("renders decompose template with all variables replaced", async () => {
    await engine.loadAll();
    const tpl = engine.get("decompose")!;
    const rendered = engine.render(tpl, TEST_VARS);

    const unreplaced = hasUnreplacedVars(rendered);
    if (unreplaced.length > 0) {
      console.log("UNREPLACED in decompose:", unreplaced);
    }
    expect(unreplaced).toEqual([]);

    console.log("=== DECOMPOSE PROMPT ===");
    console.log(rendered);
    console.log("=== END DECOMPOSE ===\n");
  });

  it("renders plan template with all variables replaced", async () => {
    await engine.loadAll();
    const tpl = engine.get("plan")!;
    const rendered = engine.render(tpl, {
      ...TEST_VARS,
      preset_role: "planner",
    });

    const unreplaced = hasUnreplacedVars(rendered);
    if (unreplaced.length > 0) {
      console.log("UNREPLACED in plan:", unreplaced);
    }
    expect(unreplaced).toEqual([]);

    console.log("=== PLAN PROMPT ===");
    console.log(rendered);
    console.log("=== END PLAN ===\n");
  });

  it("renders build template with all variables replaced", async () => {
    await engine.loadAll();
    const tpl = engine.get("build")!;
    const rendered = engine.render(tpl, {
      ...TEST_VARS,
      preset_role: "builder",
    });

    const unreplaced = hasUnreplacedVars(rendered);
    if (unreplaced.length > 0) {
      console.log("UNREPLACED in build:", unreplaced);
    }
    expect(unreplaced).toEqual([]);

    console.log("=== BUILD PROMPT ===");
    console.log(rendered);
    console.log("=== END BUILD ===\n");
  });

  it("renders verify template with all variables replaced", async () => {
    await engine.loadAll();
    const tpl = engine.get("verify")!;
    const rendered = engine.render(tpl, {
      ...TEST_VARS,
      preset_role: "verifier",
    });

    const unreplaced = hasUnreplacedVars(rendered);
    if (unreplaced.length > 0) {
      console.log("UNREPLACED in verify:", unreplaced);
    }
    expect(unreplaced).toEqual([]);

    console.log("=== VERIFY PROMPT ===");
    console.log(rendered);
    console.log("=== END VERIFY ===\n");
  });

  it("renders review template with all variables replaced", async () => {
    await engine.loadAll();
    const tpl = engine.get("review")!;
    const rendered = engine.render(tpl, {
      ...TEST_VARS,
      preset_role: "reviewer",
    });

    const unreplaced = hasUnreplacedVars(rendered);
    if (unreplaced.length > 0) {
      console.log("UNREPLACED in review:", unreplaced);
    }
    expect(unreplaced).toEqual([]);

    console.log("=== REVIEW PROMPT ===");
    console.log(rendered);
    console.log("=== END REVIEW ===\n");
  });

  it("renders accept template with all variables replaced", async () => {
    await engine.loadAll();
    const tpl = engine.get("accept")!;
    const rendered = engine.render(tpl, {
      ...TEST_VARS,
      preset_role: "accepter",
    });

    const unreplaced = hasUnreplacedVars(rendered);
    if (unreplaced.length > 0) {
      console.log("UNREPLACED in accept:", unreplaced);
    }
    expect(unreplaced).toEqual([]);

    console.log("=== ACCEPT PROMPT ===");
    console.log(rendered);
    console.log("=== END ACCEPT ===\n");
  });

  it("renders evaluate template with all variables replaced", async () => {
    const tpl = await engine.loadFile("worker-evaluate.md");
    const rendered = engine.render(tpl, {
      ...TEST_VARS,
      link: "build",
    });

    const unreplaced = hasUnreplacedVars(rendered);
    if (unreplaced.length > 0) {
      console.log("UNREPLACED in evaluate:", unreplaced);
    }
    expect(unreplaced).toEqual([]);

    console.log("=== EVALUATE PROMPT ===");
    console.log(rendered);
    console.log("=== END EVALUATE ===\n");
  });
});
