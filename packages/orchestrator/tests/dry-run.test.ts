import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runOrchestrator, type RunInput, type OrchestratorPaths } from "../src/run.js";

describe("dry-run mode", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("outputs planned workers and exits without side effects", async () => {
    const input: RunInput = {
      zk_hosts: "127.0.0.1:2181",
      worker_count: 6,
      dry_run: true,
    };
    const paths: OrchestratorPaths = {
      template_dir: "/nonexistent/templates",
      skills_dir: "/nonexistent/skills",
      child_module: "/nonexistent/child.js",
    };

    await runOrchestrator(input, paths);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("[DRY RUN] Would create 6 workers");
    expect(output).toContain("[DRY RUN] No changes made.");
  });

  it("shows role breakdown for default workers", async () => {
    const input: RunInput = {
      zk_hosts: "127.0.0.1:2181",
      worker_count: 6,
      dry_run: true,
    };
    const paths: OrchestratorPaths = {
      template_dir: "/nonexistent/templates",
      skills_dir: "/nonexistent/skills",
      child_module: "/nonexistent/child.js",
    };

    await runOrchestrator(input, paths);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    // assignRoles(6) returns planner, executor, verifier, reviewer, accepter, executor
    expect(output).toContain("1 planner");
    expect(output).toContain("2 executors");
    expect(output).toContain("1 verifier");
    expect(output).toContain("1 reviewer");
    expect(output).toContain("1 accepter");
  });

  it("includes magic-mode explorer role when --magic is set", async () => {
    const input: RunInput = {
      zk_hosts: "127.0.0.1:2181",
      worker_count: 6,
      magic: true,
      dry_run: true,
    };
    const paths: OrchestratorPaths = {
      template_dir: "/nonexistent/templates",
      skills_dir: "/nonexistent/skills",
      child_module: "/nonexistent/child.js",
    };

    await runOrchestrator(input, paths);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("1 explorer");
  });

  it("does not connect to ZooKeeper", async () => {
    const input: RunInput = {
      zk_hosts: "127.0.0.1:9999",
      worker_count: 6,
      dry_run: true,
    };
    const paths: OrchestratorPaths = {
      template_dir: "/nonexistent/templates",
      skills_dir: "/nonexistent/skills",
      child_module: "/nonexistent/child.js",
    };

    // Should not throw a ZK connection error
    await runOrchestrator(input, paths);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("[DRY RUN]");
    expect(output).not.toContain("ZooKeeper");
  });

  it("does not create files or directories", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dry-run-test-"));
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await runOrchestrator({
        zk_hosts: "127.0.0.1:2181",
        worker_count: 6,
        dry_run: true,
      }, {
        template_dir: "/nonexistent/templates",
        skills_dir: "/nonexistent/skills",
        child_module: "/nonexistent/child.js",
      });
    } finally {
      process.chdir(origCwd);
    }

    // The temp directory should still exist and be empty
    const entries = fs.readdirSync(tmpDir);
    expect(entries).toEqual([]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
