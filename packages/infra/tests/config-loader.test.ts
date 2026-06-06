// CORE-RETENTION
// Locks in: ConfigLoader's 5-layer precedence (cli > env > project >
// global > built-in defaults), home-dir + cwd path resolution, the
// `cache_dir` deprecation warning, and the round-trip contracts of
// saveInstanceId / saveProjectWorktreeConfig.
// Critical because: this module is the only path by which the
// orchestrator learns its ZK hosts, projects_root, commands, git remote,
// and hooks. A silent precedence flip (e.g. env shadowing CLI, or
// project-level cache_dir being lost when global also sets it) routes
// the entire cluster to the wrong storage root — workers create
// worktrees under a stale path while leader reads from the new one, and
// the "missing chains" failure surfaces at runtime with no logged cause.
// Primary sources: packages/infra/src/config/config-loader.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// TRUST-JUSTIFICATION: Mocking node:os.homedir for the duration of this
// test file.
// Downstream: Node stdlib — no real network or external service.
// Reason: config-loader CAPTURES
//   GLOBAL_CONFIG_DIR  = path.join(os.homedir(), ".claude-orchestrator")
//   GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "config.json")
// at IMPORT time, before any beforeEach can run. Therefore os.homedir
// must be intercepted via vi.hoisted + vi.mock BEFORE the source
// module loads. We initialize homeRef.value to a stable per-file
// tmpdir created in vi.hoisted so module-level GLOBAL_CONFIG_FILE
// resolves correctly. Per-test isolation is achieved by wiping
// ".claude-orchestrator/" inside that home between tests.
// Evidence: writeJsonAtomic + readJson still hit real fs; loadConfig
// behavior is verified through real on-disk round-trips.
const homeRef = vi.hoisted(() => {
  const fsModule = require("node:fs") as typeof import("node:fs");
  const pathModule = require("node:path") as typeof import("node:path");
  const value = fsModule.mkdtempSync(
    pathModule.join(process.env.TMPDIR ?? "/tmp", "co-cfg-home-"),
  );
  return { value };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homeRef.value };
});

import { writeJsonAtomic } from "../src/utils/fs-json.js";
import {
  loadConfig,
  loadInitStatus,
  loadProjectInitStatus,
  loadProjectWorktreeConfig,
  saveInitStatus,
  saveInstanceId,
  saveProjectInitStatus,
  saveProjectWorktreeConfig,
  type WorktreeEntry,
} from "../src/config/config-loader.js";

const fakeHome = homeRef.value;
let fakeCwd: string;
let savedEnvZkHosts: string | undefined;
let originalCwd: () => string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Wipe any state left by a previous test in the SHARED fakeHome.
  fs.rmSync(path.join(fakeHome, ".claude-orchestrator"), {
    recursive: true,
    force: true,
  });
  fakeCwd = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "co-cfg-cwd-"));
  originalCwd = process.cwd;
  process.cwd = () => fakeCwd;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  savedEnvZkHosts = process.env.ZK_HOSTS;
  delete process.env.ZK_HOSTS;
});

afterEach(() => {
  process.cwd = originalCwd;
  warnSpy.mockRestore();
  if (savedEnvZkHosts === undefined) {
    delete process.env.ZK_HOSTS;
  } else {
    process.env.ZK_HOSTS = savedEnvZkHosts;
  }
  fs.rmSync(path.join(fakeHome, ".claude-orchestrator"), {
    recursive: true,
    force: true,
  });
  fs.rmSync(fakeCwd, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

function writeGlobal(data: Record<string, unknown>): void {
  writeJsonAtomic(
    path.join(fakeHome, ".claude-orchestrator", "config.json"),
    data,
  );
}

function writeProject(data: Record<string, unknown>): void {
  writeJsonAtomic(
    path.join(fakeCwd, ".claude-orchestrator", "config.json"),
    data,
  );
}

describe("loadConfig — defaults", () => {
  it("returns full built-in defaults when no config files exist", () => {
    const cfg = loadConfig();
    expect(cfg.zk.hosts).toBe("127.0.0.1:2181");
    expect(cfg.zk.session_timeout_ms).toBe(30000);
    expect(cfg.commands.claude_cli).toContain("claude");
    expect(cfg.commands.git).toBe("git");
    expect(cfg.git.merge_target_branch).toBeNull();
    expect(cfg.git.remote).toBe("origin");
    expect(cfg.hooks).toEqual([]);
    expect(cfg.init_status).toEqual([]);
    expect(cfg.instance_id).toBeNull();
    expect(cfg.debug).toBe(false);
    expect(cfg.projects_root).toBe(
      path.join(fakeHome, ".claude-orchestrator", "projects"),
    );
  });
});

describe("loadConfig — precedence", () => {
  it("CLI > env > project > global for zk.hosts", () => {
    writeGlobal({ zookeeper: { hosts: "global:2181" } });
    writeProject({ zookeeper: { hosts: "project:2181" } });

    expect(loadConfig().zk.hosts).toBe("project:2181");

    process.env.ZK_HOSTS = "env:2181";
    expect(loadConfig().zk.hosts).toBe("env:2181");

    expect(loadConfig({ cli_zookeeper: "cli:2181" }).zk.hosts).toBe(
      "cli:2181",
    );
  });

  it("project overrides global for commands/git", () => {
    writeGlobal({
      commands: { git: "git-global" },
      git: { remote: "origin-global", merge_target_branch: "main" },
    });
    writeProject({
      commands: { git: "git-project" },
      git: { remote: "origin-project" },
    });

    const cfg = loadConfig();
    expect(cfg.commands.git).toBe("git-project");
    expect(cfg.git.remote).toBe("origin-project");
    // Project did not set merge_target_branch — global value carries through.
    expect(cfg.git.merge_target_branch).toBe("main");
  });

  it("debug: cli_debug > project.debug > global.debug", () => {
    writeGlobal({ debug: true });
    writeProject({ debug: false });
    expect(loadConfig().debug).toBe(false);

    expect(loadConfig({ cli_debug: true }).debug).toBe(true);
  });

  it("hooks: project array replaces global (no merge)", () => {
    writeGlobal({
      hooks: [{ event: "task_completed", command: "g.sh", enabled: true }],
    });
    writeProject({
      hooks: [{ event: "task_claimed", command: "p.sh", enabled: true }],
    });

    const cfg = loadConfig();
    expect(cfg.hooks).toHaveLength(1);
    expect(cfg.hooks[0]).toMatchObject({ command: "p.sh" });
  });
});

describe("loadConfig — projects_root resolution", () => {
  it("expands a leading '~' to the (redirected) HOME", () => {
    writeProject({ projects_root: "~/custom-projects" });
    expect(loadConfig().projects_root).toBe(
      path.join(fakeHome, "custom-projects"),
    );
  });

  it("resolves a relative path against cwd", () => {
    writeProject({ projects_root: "rel-projects" });
    expect(loadConfig().projects_root).toBe(
      path.join(fakeCwd, "rel-projects"),
    );
  });

  it("accepts an absolute path unchanged", () => {
    const abs = path.join(fakeHome, "abs-projects");
    writeProject({ projects_root: abs });
    expect(loadConfig().projects_root).toBe(abs);
  });
});

describe("loadConfig — deprecated cache_dir", () => {
  it("uses cache_dir as projects_root AND emits a deprecation warning", () => {
    writeGlobal({ cache_dir: "~/legacy-cache" });

    const cfg = loadConfig();
    expect(cfg.projects_root).toBe(path.join(fakeHome, "legacy-cache"));

    expect(warnSpy).toHaveBeenCalled();
    const calls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((msg) => msg.includes("cache_dir") && msg.includes("deprecated"))).toBe(true);
  });

  it("does NOT warn when projects_root is set even alongside cache_dir", () => {
    writeProject({
      projects_root: "~/new-projects",
      cache_dir: "~/legacy-cache",
    });

    const cfg = loadConfig();
    expect(cfg.projects_root).toBe(path.join(fakeHome, "new-projects"));
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("save/load round-trips", () => {
  it("saveInstanceId then loadConfig preserves instance_id as a branded InstanceId", () => {
    saveInstanceId("leader-x-001");
    const cfg = loadConfig();
    expect(cfg.instance_id).toBe("leader-x-001");
  });

  it("saveProjectWorktreeConfig then loadProjectWorktreeConfig round-trips entries", () => {
    const entries: Record<string, WorktreeEntry> = {
      Tom: {
        name: "Tom",
        role: "planner",
        path: ".claude-orchestrator/worktree/Tom",
        branch: "claude-orchestrator/Tom-workspace",
        instance_id: "tom-seed",
      },
      Jerry: {
        name: "Jerry",
        role: "executor",
        path: ".claude-orchestrator/worktree/Jerry",
        branch: "claude-orchestrator/Jerry-workspace",
        instance_id: "jerry-seed",
      },
    };
    saveProjectWorktreeConfig(entries);

    const loaded = loadProjectWorktreeConfig();
    expect(loaded).toEqual(entries);
  });

  it("saveInitStatus / loadInitStatus round-trips global init_status", () => {
    const entries = [
      { project: "/abs/path", status: "ok" as const, ts: "2026-05-25" },
    ];
    saveInitStatus(entries);
    expect(loadInitStatus()).toEqual(entries);
  });

  it("saveProjectInitStatus / loadProjectInitStatus round-trips project init_status", () => {
    const entries = [
      { project: ".", status: "ok" as const, ts: "2026-05-25" },
    ];
    saveProjectInitStatus(entries);
    expect(loadProjectInitStatus()).toEqual(entries);
  });

  it("saveInstanceId preserves other existing keys in the same project config", () => {
    writeProject({
      name: "MyTeam",
      role: "leader",
    });
    saveInstanceId("leader-y");

    const cfg = loadConfig();
    expect(cfg.instance_id).toBe("leader-y");
    expect(cfg.name).toBe("MyTeam");
    expect(cfg.role).toBe("leader");
  });
});

describe("loadConfig — edge cases", () => {
  it("throws when global config file is malformed JSON", () => {
    const configDir = path.join(fakeHome, ".claude-orchestrator");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), "{invalid json", "utf-8");

    expect(() => loadConfig()).toThrow();
  });

  it("throws when project config file is malformed JSON", () => {
    const configDir = path.join(fakeCwd, ".claude-orchestrator");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), "not json at all", "utf-8");

    expect(() => loadConfig()).toThrow();
  });

  it("returns defaults when config files do not exist", () => {
    const cfg = loadConfig();
    expect(cfg.zk.hosts).toBe("127.0.0.1:2181");
    expect(cfg.hooks).toEqual([]);
    expect(cfg.init_status).toEqual([]);
  });

  it("cli_debug overrides project.debug=true", () => {
    writeProject({ debug: true });
    expect(loadConfig({ cli_debug: false }).debug).toBe(false);
  });

  it("session_timeout_ms is preserved from global config", () => {
    writeGlobal({ zookeeper: { session_timeout_ms: 60000 } });
    const cfg = loadConfig();
    expect(cfg.zk.session_timeout_ms).toBe(60000);
  });

  it("session_timeout_ms is overridden by project config", () => {
    writeGlobal({ zookeeper: { session_timeout_ms: 60000 } });
    writeProject({ zookeeper: { session_timeout_ms: 15000 } });
    const cfg = loadConfig();
    expect(cfg.zk.session_timeout_ms).toBe(15000);
  });

  it("instance_id from project config is loaded", () => {
    writeProject({ instance_id: "custom-id-123" });
    const cfg = loadConfig();
    expect(cfg.instance_id).toBe("custom-id-123");
  });

  it("name from project config is loaded", () => {
    writeProject({ name: "TestProject" });
    const cfg = loadConfig();
    expect(cfg.name).toBe("TestProject");
  });

  it("role from project config is loaded", () => {
    writeProject({ role: "leader" });
    const cfg = loadConfig();
    expect(cfg.role).toBe("leader");
  });

  it("auto_commit_init_files defaults to true", () => {
    const cfg = loadConfig();
    expect(cfg.git.auto_commit_init_files).toBe(true);
  });

  it("auto_commit_init_files can be disabled in project config", () => {
    writeProject({ git: { auto_commit_init_files: false } });
    const cfg = loadConfig();
    expect(cfg.git.auto_commit_init_files).toBe(false);
  });

  it("auto_commit_init_files_branch defaults to null", () => {
    const cfg = loadConfig();
    expect(cfg.git.auto_commit_init_files_branch).toBeNull();
  });

  it("remote defaults to 'origin'", () => {
    const cfg = loadConfig();
    expect(cfg.git.remote).toBe("origin");
  });

  it("merge_target_branch defaults to null", () => {
    const cfg = loadConfig();
    expect(cfg.git.merge_target_branch).toBeNull();
  });
});

describe("loadConfig — projects_root edge cases", () => {
  it("defaults to ~/.claude-orchestrator/projects when no config set", () => {
    const cfg = loadConfig();
    expect(cfg.projects_root).toBe(
      path.join(fakeHome, ".claude-orchestrator", "projects"),
    );
  });

  it("project config overrides global projects_root", () => {
    writeGlobal({ projects_root: "~/global-projects" });
    writeProject({ projects_root: "~/project-projects" });
    const cfg = loadConfig();
    expect(cfg.projects_root).toBe(path.join(fakeHome, "project-projects"));
  });

  it("global projects_root is used when project not set", () => {
    writeGlobal({ projects_root: "~/global-projects" });
    const cfg = loadConfig();
    expect(cfg.projects_root).toBe(path.join(fakeHome, "global-projects"));
  });
});

describe("loadConfig — schema validation", () => {
  it("throws ConfigValidationError for invalid global zookeeper hosts", () => {
    writeGlobal({ zookeeper: { hosts: "" } });
    expect(() => loadConfig()).toThrow("invalid entries");
  });

  it("throws ConfigValidationError for invalid project role", () => {
    writeProject({ role: "invalid-role" });
    expect(() => loadConfig()).toThrow("invalid entries");
  });

  it("throws ConfigValidationError for invalid hook event type", () => {
    writeProject({
      hooks: [{ event: "invalid_event", command: "cmd", enabled: true }],
    });
    expect(() => loadConfig()).toThrow("invalid entries");
  });

  it("throws ConfigValidationError for non-boolean debug in global config", () => {
    writeGlobal({ debug: "not-a-bool" });
    expect(() => loadConfig()).toThrow("invalid entries");
  });

  it("throws ConfigValidationError for non-boolean debug in project config", () => {
    writeProject({ debug: 123 });
    expect(() => loadConfig()).toThrow("invalid entries");
  });

  it("valid config with all fields passes validation", () => {
    writeGlobal({
      zookeeper: { hosts: "zk:2181", session_timeout_ms: 30000 },
      commands: { claude_cli: "claude", git: "git" },
      git: {
        merge_target_branch: "main",
        remote: "origin",
        auto_commit_init_files: true,
        auto_commit_init_files_branch: null,
      },
      hooks: [],
      debug: false,
    });
    writeProject({
      name: "TestProject",
      role: "leader",
      projects_root: "~/test-projects",
    });
    const cfg = loadConfig();
    expect(cfg.name).toBe("TestProject");
    expect(cfg.role).toBe("leader");
  });

  it("empty config files pass validation (all fields optional)", () => {
    writeGlobal({});
    writeProject({});
    const cfg = loadConfig();
    expect(cfg.zk.hosts).toBe("127.0.0.1:2181");
  });

  it("partial config files pass validation", () => {
    writeGlobal({ zookeeper: { hosts: "zk:2181" } });
    writeProject({ git: { remote: "upstream" } });
    const cfg = loadConfig();
    expect(cfg.zk.hosts).toBe("zk:2181");
    expect(cfg.git.remote).toBe("upstream");
  });
});
