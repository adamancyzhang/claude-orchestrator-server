// CORE-RETENTION
// Locks in: `runOrchestrator({ worker_count: 6 })` produces the filesystem
//   layout, ZK node tree, and LeaderState described in
//   docs/evals/01-startup-worker-6.md.
// Core path because: this is the canonical product entry; any drift
//   between docs/evals and code regresses user expectations on day-1
//   startup, and the eval doc is what we point new contributors at.
// Owner subsystem: orchestrator.
// Primary source files exercised:
//   - packages/orchestrator/src/run.ts
//   - packages/orchestrator/src/worktree-initializer.ts
//   - packages/orchestrator/src/co-root-initializer.ts
//   - packages/orchestrator/src/init-checker.ts
//   - packages/coordination/src/instance-registry.ts
//   - packages/leader/src/state.ts
//   - packages/leader/src/monitor.ts
//
// Divergence from tests/CLAUDE.md §4.3: this e2e uses an in-memory ZK
// fake instead of docker-compose ZooKeeper. The user explicitly
// requested simulated ZK so the test can snapshot the resulting node
// tree without external services. The fake's TRUST-JUSTIFICATION is in
// `packages/orchestrator/tests/helpers/in-memory-zk-client.ts`.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  runOrchestrator,
  type OrchestratorPaths,
} from "../../../src/index.js";
import {
  InMemoryZkClient,
  Logger,
  type ZkTreeNode,
} from "@co/infra";
import { FakeChildSupervisor } from "../../helpers/fake-child-supervisor.js";
import { createTempProject, type TempProject } from "../../helpers/tmp-project.js";
import { dumpDir, findNode, childNames } from "../../helpers/tree-snapshot.js";
import { withTempHome, type IsolatedHome } from "../../helpers/home-isolation.js";

// Resolve the real templates/ and skills/ directories at the repo root
// so the temp project is seeded from production content.
const PKG_ROOT = path.resolve(__dirname, "..", "..", "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const REAL_TEMPLATES = path.join(REPO_ROOT, "templates");
const REAL_SKILLS = path.join(REPO_ROOT, "skills");

interface RunArtifacts {
  /** ZK tree captured *before* shutdown (so ephemeral nodes are still present). */
  zk_tree: ZkTreeNode;
  /** Names registered by the fake supervisor, in order. */
  registered_names: readonly string[];
  proj: TempProject;
  home: IsolatedHome;
  prev_cwd: string;
}

async function bootWorker6(): Promise<RunArtifacts> {
  const home = withTempHome();
  const proj = createTempProject({
    source_templates_dir: REAL_TEMPLATES,
    source_skills_dir: REAL_SKILLS,
  });
  const prev_cwd = process.cwd();
  process.chdir(proj.root);

  // Track the fake instances by reference so we can snapshot them and
  // also assert on the order of registration.
  let zk: InMemoryZkClient | undefined;
  let supervisor: FakeChildSupervisor | undefined;

  const paths: OrchestratorPaths = {
    template_dir: proj.templates_dir,
    skills_dir: proj.skills_dir,
    // We never fork, so this never gets used — but keep it defined so
    // ChildSupervisorOptions stays valid for the fake's typecheck.
    child_module: path.join(proj.root, "_unused_child.js"),
  };

  // Drive shutdown explicitly so runOrchestrator returns. We resolve it
  // after Phase 4 finished (i.e. after the orchestrator has wired
  // everything up and the fake supervisor's start() returned).
  let signalShutdown!: () => void;
  const shutdown_signal = new Promise<void>((res) => {
    signalShutdown = res;
  });

  const runPromise = runOrchestrator(
    {
      zk_hosts: "in-memory",
      worker_count: 6,
      y_flag: true,
      debug: false,
    },
    paths,
    {
      // The factory is the only place the orchestrator hands us the
      // ensure_paths from `zkPaths.allEnsurePaths()`. Construct the
      // fake here so the 7 base paths get pre-created (matches what
      // a real ZK server would have after connect()).
      zk_factory: (opts) => {
        zk = new InMemoryZkClient({ ensure_paths: opts.ensure_paths });
        return zk;
      },
      supervisor_factory: () => {
        if (!zk) throw new Error("zk_factory must run before supervisor_factory");
        supervisor = new FakeChildSupervisor({
          zk,
          logger: new Logger({ namespace: "test-supervisor", level: "warn" }),
        });
        return supervisor;
      },
      headless: true,
      shutdown_signal,
    },
  );

  // Wait until the fake supervisor has registered all 6 workers, then
  // give the WorkerMonitor watch one tick to fan-out worker_joined.
  await waitFor(
    () => !!supervisor && supervisor.get_registered().length === 6,
    {
      timeout_ms: 5_000,
      label: "fake supervisor registered 6 workers",
    },
  );
  // The WorkerMonitor.watch() initial onChange runs synchronously, but
  // subsequent fires go through the in-memory watch fan-out queue. A
  // single microtask drain is enough to let everything settle.
  await new Promise((r) => setTimeout(r, 25));

  // Snapshot the live ZK tree BEFORE shutdown — the fake's close() sweeps
  // ephemeral nodes (mirroring real ZK semantics), so the post-shutdown
  // tree would be empty and the test would have nothing to assert on.
  const zk_tree = zk!.dumpTree();
  const registered_names = supervisor!.get_registered().map((r) => r.name);

  signalShutdown();
  await runPromise;

  return { zk_tree, registered_names, proj, home, prev_cwd };
}

async function waitFor(
  pred: () => boolean,
  opts: { timeout_ms: number; label: string; interval_ms?: number },
): Promise<void> {
  const start = Date.now();
  const interval = opts.interval_ms ?? 10;
  while (Date.now() - start < opts.timeout_ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timeout waiting for: ${opts.label}`);
}

describe("eval 01: startup --worker 6", () => {
  let art: RunArtifacts;

  beforeAll(async () => {
    art = await bootWorker6();
  }, 30_000);

  afterAll(() => {
    process.chdir(art.prev_cwd);
    art.proj.cleanup();
    art.home.cleanup();
    art.home.restore();
  });

  it("seeds the 6 worktrees with the documented names and assets (eval §3.2, §3.8.1)", () => {
    const tree = dumpDir(art.proj.root, { exclude_sizes: true });

    // 1. .claude-orchestrator/worktree exists with all 6 expected names
    const worktreeRoot = findNode(tree, ".claude-orchestrator/worktree");
    expect(worktreeRoot, "expected worktree root to exist").toBeDefined();
    expect(childNames(worktreeRoot)).toEqual(
      ["Jack", "Jerry", "Lisa", "Lucy", "Thomas", "Tom"], // sorted
    );

    // 2. Each worktree has CLAUDE.md + .claude/skills (10) + .claude-orchestrator/agents
    //    (= 20 from templates/agents + 1 personal-claude-<role>.md seeded from
    //     templates/claude-memory; see worktree-initializer.ts:311-320).
    const expectedAgentCount = fs.readdirSync(REAL_TEMPLATES + "/agents")
      .filter((f) => f.endsWith(".md")).length;
    const expectedSkillCount = fs.readdirSync(REAL_SKILLS)
      .filter((d) => d !== "CLAUDE.md" && fs.existsSync(path.join(REAL_SKILLS, d, "SKILL.md"))).length;
    const expectedWorktreeAgentCount = expectedAgentCount + 1; // +1 personal-claude-<role>

    expect(expectedAgentCount, "expect 20 agent templates").toBe(20);
    expect(expectedSkillCount, "expect 10 skills").toBe(10);

    for (const name of ["Tom", "Jerry", "Lucy", "Thomas", "Jack", "Lisa"]) {
      const wt = findNode(tree, `.claude-orchestrator/worktree/${name}`);
      expect(wt, `worktree/${name} missing`).toBeDefined();

      // CLAUDE.md is the team memory file (byte-equal to source).
      const claudeMdSrc = path.join(REAL_TEMPLATES, "claude-memory", "team-claude.md");
      const claudeMdDst = path.join(art.proj.root, ".claude-orchestrator", "worktree", name, "CLAUDE.md");
      expect(fs.readFileSync(claudeMdDst, "utf-8"))
        .toBe(fs.readFileSync(claudeMdSrc, "utf-8"));

      // .claude-orchestrator/agents/*.md (20 from templates/agents + 1 personal-claude-<role>)
      const agentsNode = findNode(tree, `.claude-orchestrator/worktree/${name}/.claude-orchestrator/agents`);
      expect(childNames(agentsNode).length, `${name}: agents count`).toBe(expectedWorktreeAgentCount);

      // .claude/skills/<each>/SKILL.md
      const skillsNode = findNode(tree, `.claude-orchestrator/worktree/${name}/.claude/skills`);
      expect(skillsNode?.type).toBe("dir");
      expect(childNames(skillsNode).length, `${name}: skills count`).toBe(expectedSkillCount);
      for (const skill of skillsNode!.children!) {
        const skillFile = findNode(skillsNode, `${skill.name}/SKILL.md`);
        expect(skillFile?.type, `${name}/${skill.name}/SKILL.md missing`).toBe("file");
      }
    }

    // 3. Project also has the workspace-level worktree registry config.
    const cfgFile = findNode(tree, ".claude-orchestrator/config.json");
    expect(cfgFile?.type, "project .claude-orchestrator/config.json missing").toBe("file");
  });

  it("produces the ZK node tree from eval §3.7 with leader + 6 worker EPHEMERAL instances", () => {
    const root = art.zk_tree;
    // Sanity: the tree starts at /claude-orchestrator
    expect(root.path).toBe("/claude-orchestrator");

    expect(root.name).toBe("claude-orchestrator");
    const topNames = root.children.map((c) => c.name).sort();
    expect(topNames).toEqual(["instances", "leader", "messages", "tasks"]);

    // /claude-orchestrator/leader is EPHEMERAL with the documented payload.
    const leader = root.children.find((c) => c.name === "leader")!;
    expect(leader.ephemeral, "leader node should be EPHEMERAL").toBe(true);
    expect(leader.data, "leader payload should be non-empty").toBeTruthy();
    const leaderPayload = JSON.parse(leader.data!);
    expect(leaderPayload).toMatchObject({
      protocol_version: expect.any(String),
      leader_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      pid: expect.any(Number),
      host: expect.any(String),
      started_at: expect.any(String),
      magic_mode: false,
      magic_max_chains: null,
    });

    // /claude-orchestrator/instances has 1 leader + 6 workers, all EPHEMERAL.
    const instances = root.children.find((c) => c.name === "instances")!;
    expect(instances.children.length, "instances count (1 leader + 6 workers)").toBe(7);
    for (const inst of instances.children) {
      expect(inst.ephemeral, `instance ${inst.name} should be EPHEMERAL`).toBe(true);
      expect(inst.data, `instance ${inst.name} payload`).toBeTruthy();
    }

    // The 6 worker instance payloads carry the expected names + roles.
    const instancePayloads = instances.children.map((c) => JSON.parse(c.data!));
    const workerPayloads = instancePayloads.filter((p) => p.role !== "leader");
    expect(workerPayloads.length).toBe(6);

    const byName = new Map(workerPayloads.map((p) => [p.name, p]));
    const expectedPairs: ReadonlyArray<[string, string]> = [
      ["Tom", "planner"],
      ["Jerry", "executor"],
      ["Lucy", "verifier"],
      ["Thomas", "reviewer"],
      ["Jack", "accepter"],
      ["Lisa", "executor"],
    ];
    for (const [name, role] of expectedPairs) {
      const p = byName.get(name);
      expect(p, `worker ${name} missing from ZK`).toBeDefined();
      expect(p!.role, `worker ${name} role`).toBe(role);
      expect(p!.status).toBe("idle");
      expect(p!.pid).toBeGreaterThan(0);
      expect(p!.current_task_id).toBe(null);
      expect(p!.worktree_branch).toMatch(/^claude-orchestrator\//);
      expect(p!.protocol_version).toBe(leaderPayload.protocol_version);
    }

    // tasks/{pending,claimed,completed} are present and empty.
    const tasks = root.children.find((c) => c.name === "tasks")!;
    const taskBuckets = tasks.children.map((c) => c.name).sort();
    expect(taskBuckets).toEqual(["claimed", "completed", "pending"]);
    for (const bucket of tasks.children) {
      expect(bucket.children.length, `tasks/${bucket.name} should be empty at startup`).toBe(0);
    }

    // messages/ exists; only the leader's message dir is present (created
    // by LeaderWatcher.waitForMessage via mkdirp).
    const messages = root.children.find((c) => c.name === "messages")!;
    // Either empty, or contains exactly the leader's instance dir.
    if (messages.children.length > 0) {
      expect(messages.children.length).toBe(1);
      expect(messages.children[0].name).toBe(leaderPayload.leader_id);
      expect(messages.children[0].children.length).toBe(0);
    }
  });

  it("provisions the CO root under HOME with .git + .gitignore + README.md (eval §3.8.2)", () => {
    // CO root path is `${projects_root}/${leader_id}` where
    // projects_root defaults to `~/.claude-orchestrator/projects`.
    const root = art.zk_tree;
    const leaderPayload = JSON.parse(
      root.children.find((c) => c.name === "leader")!.data!,
    );
    const coRoot = path.join(
      art.home.home,
      ".claude-orchestrator",
      "projects",
      leaderPayload.leader_id,
    );
    expect(fs.existsSync(coRoot), `co-root should exist at ${coRoot}`).toBe(true);

    const tree = dumpDir(coRoot, { ignore: [], exclude_sizes: true });
    const names = childNames(tree);
    // ensureCoRoot writes: .git/, .gitignore, README.md. (chains/,
    // tasks/, messages/, docs/, merges/, audit.jsonl are lazy — see
    // Findings note in docs/evals/01-startup-worker-6.md.)
    expect(names).toEqual(expect.arrayContaining([".git", ".gitignore", "README.md"]));
    expect(fs.readFileSync(path.join(coRoot, ".gitignore"), "utf-8"))
      .toContain("tasks/*/exec-*.log");
  });

  it("produces the LeaderState shape from eval §4 (observable via ZK + supervisor)", () => {
    // We don't have direct access to LeaderState from inside the test
    // (runOrchestrator owns it), but the documented invariants are all
    // observable via the fake ZK and the supervisor's registry.
    const root = art.zk_tree;
    const instances = root.children.find((c) => c.name === "instances")!;
    const workerPayloads = instances.children
      .map((c) => JSON.parse(c.data!))
      .filter((p) => p.role !== "leader");

    expect(workerPayloads.length, "state.workers.length === 6").toBe(6);
    expect(workerPayloads.every((w) => w.status === "idle")).toBe(true);
    expect(workerPayloads.every((w) => typeof w.pid === "number" && w.pid > 0)).toBe(true);
    expect(workerPayloads.every((w) => w.current_task_id === null)).toBe(true);
    expect(
      workerPayloads.every((w) => w.worktree_branch?.startsWith("claude-orchestrator/")),
    ).toBe(true);

    // Names and preset roles in the order the orchestrator assigned them
    // are documented; the fake supervisor preserves insertion order.
    expect(art.registered_names).toEqual([
      "Tom", "Jerry", "Lucy", "Thomas", "Jack", "Lisa",
    ]);
    const byName = new Map(workerPayloads.map((p) => [p.name, p]));
    expect(byName.get("Tom")?.role).toBe("planner");
    expect(byName.get("Jerry")?.role).toBe("executor");
    expect(byName.get("Lucy")?.role).toBe("verifier");
    expect(byName.get("Thomas")?.role).toBe("reviewer");
    expect(byName.get("Jack")?.role).toBe("accepter");
    expect(byName.get("Lisa")?.role).toBe("executor");

    // magic_mode + magic_max_chains come from the leader payload.
    const leaderPayload = JSON.parse(
      root.children.find((c) => c.name === "leader")!.data!,
    );
    expect(leaderPayload.magic_mode).toBe(false);
    expect(leaderPayload.magic_max_chains).toBe(null);
  });
});
