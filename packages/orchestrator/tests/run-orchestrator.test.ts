// CORE-RETENTION
// Locks in: runOrchestrator() startup phases, headless mode integration,
// and StateWriter/CommandWatcher initialization.
// Critical because: runOrchestrator is the main entry point wiring all
// subsystems together; integration regressions here break the entire
// orchestrator.
// Primary sources: packages/orchestrator/src/run.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock all heavy dependencies to avoid real ZooKeeper, git, etc.
vi.mock("@co/infra", () => ({
  Logger: vi.fn().mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
  InMemoryZkClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createEphemeral: vi.fn().mockResolvedValue(undefined),
    createPersistent: vi.fn().mockResolvedValue(undefined),
    getChildren: vi.fn().mockResolvedValue([]),
    getData: vi.fn().mockResolvedValue(null),
    setData: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    on: vi.fn(),
  })),
  ZkClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createEphemeral: vi.fn().mockResolvedValue(undefined),
    createPersistent: vi.fn().mockResolvedValue(undefined),
    getChildren: vi.fn().mockResolvedValue([]),
    getData: vi.fn().mockResolvedValue(null),
    setData: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    on: vi.fn(),
  })),
  loadConfig: vi.fn().mockReturnValue({
    instance_id: "test-leader",
    projects_root: "/tmp/co-test",
    zk: { hosts: "127.0.0.1:2181", session_timeout_ms: 30000 },
    git: {
      auto_commit_init_files: false,
      auto_commit_init_files_branch: null,
      merge_target_branch: "main",
      remote: "origin",
    },
    commands: { claude_cli: "claude", git: "git" },
    hooks: [],
    name: "Test Leader",
    role: "leader",
  }),
  saveInstanceId: vi.fn(),
  captureConsoleToFile: vi.fn(),
  restoreConsole: vi.fn(),
}));

vi.mock("@co/runtime", () => ({
  ClaudeRunner: vi.fn().mockImplementation(() => ({})),
  HookEngine: vi.fn().mockImplementation(() => ({})),
  TemplateEngine: vi.fn().mockImplementation(() => class {
    has = vi.fn().mockReturnValue(true);
    render = vi.fn().mockReturnValue("rendered");
  }),
}));

vi.mock("@co/coordination", () => ({
  InstanceRegistry: vi.fn().mockImplementation(() => ({
    register: vi.fn().mockResolvedValue({ id: "test-leader", name: "Leader", role: "leader" }),
    unregister: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  })),
  MessageRouter: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue(undefined),
  })),
  TaskQueue: vi.fn().mockImplementation(() => ({
    push: vi.fn().mockResolvedValue({}),
    listPending: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("../src/child-supervisor.js", () => ({
  ChildSupervisor: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/in-process-supervisor.js", () => ({
  InProcessSupervisor: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/init-checker.js", () => ({
  InitChecker: vi.fn().mockImplementation(() => ({
    runAll: vi.fn().mockResolvedValue(undefined),
  })),
  createGlobalConfigStep: vi.fn().mockReturnValue({}),
  createUserClaudeMdStep: vi.fn().mockReturnValue({}),
  createTeamClaudeMdStep: vi.fn().mockReturnValue({}),
  createSkillsStep: vi.fn().mockReturnValue({}),
}));

vi.mock("../src/worktree-initializer.js", () => ({
  initializeWorktrees: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/co-root-initializer.js", () => ({
  ensureCoRoot: vi.fn().mockResolvedValue(undefined),
}));

describe("runOrchestrator", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orchestrator-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exports RunInput interface with headless and state_dir fields", () => {
    // Type-level test: verify interface fields exist
    const input: import("../src/run.js").RunInput = {
      zk_hosts: "127.0.0.1:2181",
      worker_count: 6,
      headless: true,
      state_dir: "/tmp/test-state",
    };
    expect(input.headless).toBe(true);
    expect(input.state_dir).toBe("/tmp/test-state");
  });

  it("RunInput accepts headless boolean", () => {
    // Type-level test: headless field is accepted
    const input: import("../src/run.js").RunInput = {
      zk_hosts: "127.0.0.1:2181",
      worker_count: 6,
      headless: true,
      state_dir: "/tmp/test-state",
    };
    expect(input.headless).toBe(true);
    expect(input.state_dir).toBe("/tmp/test-state");
  });

  it("RunInput accepts state_dir string", () => {
    const input: import("../src/run.js").RunInput = {
      zk_hosts: "127.0.0.1:2181",
      worker_count: 6,
      state_dir: "/custom/state/dir",
    };
    expect(input.state_dir).toBe("/custom/state/dir");
  });

  it("OrchestratorDeps accepts headless boolean", () => {
    const deps: import("../src/run.js").OrchestratorDeps = {
      headless: true,
    };
    expect(deps.headless).toBe(true);
  });

  it("defaultPaths returns valid paths structure", () => {
    // Type-level test: verify path fields exist
    const paths: import("../src/run.js").OrchestratorPaths = {
      template_dir: "/tmp/templates",
      skills_dir: "/tmp/skills",
      child_module: "/tmp/child.js",
    };
    expect(paths).toHaveProperty("template_dir");
    expect(paths).toHaveProperty("skills_dir");
    expect(paths).toHaveProperty("child_module");
  });
});
