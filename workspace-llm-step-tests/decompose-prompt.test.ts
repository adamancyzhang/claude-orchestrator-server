import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { ClaudeRunner } from "../src/executor/runner.js";
import { TemplateEngine } from "../src/executor/template.js";
import type { WorkerIdentity } from "../src/executor/runner.js";

const CLAUDE_CMD = process.env.CLAUDE_CMD || "claude --dangerously-skip-permissions --permission-mode dontAsk";
const CACHE_DIR = process.env.STEP_CACHE_DIR || "/tmp/prompt-test-cache";
const TEMPLATES_DIR = path.resolve("templates/agents");
const TEST_TIMEOUT = Number(process.env.STEP_TIMEOUT_SEC || 180) * 1000;

const identity: WorkerIdentity = {
  name: "DecomposeTester",
  role: "planner",
  worktreePath: "/tmp/decompose-test-worktree",
  worktreeBranch: "co-worker-DecomposeTester",
  instanceId: "decompose-test-001",
};

describe("Decompose Prompt (worker-decompose.md)", () => {
  const engine = new TemplateEngine(TEMPLATES_DIR);
  const runner = new ClaudeRunner(CLAUDE_CMD, CACHE_DIR, "leader-step", process.cwd(), identity);

  it(
    "renders template, runs claude, and writes valid ChainDef JSON to result_path",
    { timeout: TEST_TIMEOUT },
    async () => {
      const template = await engine.loadFile("worker-decompose.md");
      expect(template.length).toBeGreaterThan(0);

      const resultPath = runner.resultPath("decompose-chain");

      const rendered = engine.render(template, {
        name: identity.name,
        task_description: "Write a function that validates email addresses and returns true/false.",
        result_path: resultPath,
      });

      const unreplaced = rendered.match(/\{\{(\w+)\}\}/g);
      expect(unreplaced).toBeNull();

      const logPath = runner.logPath("decompose-chain");
      const t0 = Date.now();
      const result = await runner.run(rendered, logPath);
      console.log(`  Exit: ${result.code}, elapsed: ${Date.now() - t0}ms`);

      expect(result.code).toBe(0);

      // Read the ChainDef JSON from the result file written by claude
      expect(fs.existsSync(resultPath)).toBe(true);
      const resultContent = fs.readFileSync(resultPath, "utf-8");
      console.log(`  Result file size: ${resultContent.length} bytes`);

      const chainDef = JSON.parse(resultContent);

      expect(chainDef.chain_id).toBeTruthy();
      expect(chainDef.chain_title).toBeTruthy();
      expect(chainDef.tasks).toBeTruthy();

      for (const link of ["build", "verify", "review", "accept"]) {
        expect(chainDef.tasks[link]).toBeTruthy();
        expect(chainDef.tasks[link].title).toBeTruthy();
        expect(chainDef.tasks[link].description).toBeTruthy();
        expect(chainDef.tasks[link].criteria).toBeTruthy();
      }

      console.log(`  Chain ID: ${chainDef.chain_id}, Title: ${chainDef.chain_title}`);
      console.log(`  Tasks: ${Object.keys(chainDef.tasks).join(", ")}`);
    },
  );
});
