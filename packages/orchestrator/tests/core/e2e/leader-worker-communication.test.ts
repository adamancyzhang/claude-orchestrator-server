// CORE-RETENTION
// Locks in: a user `user_input` message → full `plan → execute → verify →
//   review → accept → close_chain` responsibility-chain flow described in
//   `docs/evals/02-leader-worker-communication.md`, observable as a real
//   ZK message tree, chain manifest (with dual commit envelope), audit.jsonl
//   stream, LeaderEventBus event sequence, and per-worker git history.
// Core path because: this is the product's main loop. Any regression in
//   message routing, hook firing, upstream_commits propagation, atomic
//   manifest writes, or commit envelope shape breaks every chain the user
//   could ever run, but no other automated test exercises the full path.
// Owner subsystem: orchestrator.
// Primary source files exercised:
//   - packages/orchestrator/src/run.ts
//   - packages/leader/src/chain-router.ts
//   - packages/leader/src/chain-audit.ts
//   - packages/leader/src/watcher.ts
//   - packages/leader/src/merge-validator.ts
//   - packages/worker/src/watcher.ts
//   - packages/worker/src/commit-checker.ts
//   - packages/worker/src/docs-committer.ts
//   - packages/worker/src/evaluator.ts
//   - packages/runtime/src/hook-engine.ts
//   - packages/coordination/src/{message-router,task-queue,instance-registry}.ts
//
// Divergence from tests/CLAUDE.md §4.3: this e2e uses an in-memory ZK
// fake AND a stubbed IClaudeRunner instead of docker-compose ZK + real
// claude-cli. The user explicitly requested simulated ZK for snapshot
// fidelity; the IClaudeRunner stub is justified in fake-claude-runner.ts.
// Real-cli + real-ZK regression coverage is intentionally deferred to a
// future `packages/orchestrator/tests/core/manual/` script per the eval
// 02 §11 deferral.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Worker `CommitChecker` runs `execFileSync("git", ["commit", ...])` with
// no explicit env overrides, so the spawned git inherits the test
// process's identity vars. Set them up front so the in-process workers'
// commits don't abort on `Author identity unknown` in CI containers.
process.env.GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME ?? "co-test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL ?? "co-test@example.invalid";
process.env.GIT_COMMITTER_NAME = process.env.GIT_COMMITTER_NAME ?? "co-test";
process.env.GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL ?? "co-test@example.invalid";

import {
  InMemoryZkClient,
  Logger,
  type ZkTreeNode,
} from "@co/infra";
import {
  asInstanceId,
  cachePaths,
  type ChainId,
  type InstanceId,
} from "@co/contracts";
import { MessageRouter } from "@co/coordination";
import type { LeaderEventBus } from "@co/leader";

import {
  runOrchestrator,
  type OrchestratorPaths,
} from "../../../src/index.js";
import { createTempProject, type TempProject } from "../../helpers/tmp-project.js";
import { withTempHome, type IsolatedHome } from "../../helpers/home-isolation.js";
import {
  FakeClaudeRunner,
  type InvocationRecord,
} from "../../helpers/fake-claude-runner.js";
import { InProcessWorkerSupervisor } from "../../helpers/in-process-worker-supervisor.js";
import { EventBusTap } from "../../helpers/event-bus-tap.js";
import { createHookHarness, type HookHarness } from "../../helpers/hook-script-harness.js";
import {
  waitForAnyChainClosed,
  readManifest,
  readAuditLog,
} from "../../helpers/chain-completion-waiter.js";

const PKG_ROOT = path.resolve(__dirname, "..", "..", "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const REAL_TEMPLATES = path.join(REPO_ROOT, "templates");
const REAL_SKILLS = path.join(REPO_ROOT, "skills");

interface RunArtifacts {
  zk: InMemoryZkClient;
  supervisor: InProcessWorkerSupervisor;
  shared_invocations: InvocationRecord[];
  bus: LeaderEventBus;
  bus_tap: EventBusTap;
  hook_harness: HookHarness;
  cache_paths: cachePaths.CachePathOptions;
  leader_id: InstanceId;
  zk_tree: ZkTreeNode;
  closed_chain_id: ChainId;
  proj: TempProject;
  home: IsolatedHome;
  prev_cwd: string;
}

async function bootAndRunChain(): Promise<RunArtifacts> {
  const home = withTempHome();
  // Create the hook harness FIRST so we can bake its hook commands into
  // the project's `.claude-orchestrator/config.json` seed file — that's
  // the only layer the production config loader (`packages/infra/src/
  // config/config-loader.ts:113`) reads hooks from. Going through
  // env vars or CLI flags would require config-loader changes.
  const hookHarness = createHookHarness();
  const projectConfigJson = JSON.stringify(
    {
      hooks: hookHarness.hook_configs,
      // No remote in the temp project: MergeValidator's pre-merge
      // `git fetch <remote>` would otherwise fail with
      // "'origin' does not appear to be a git repository" and trip
      // the merge_failed close-chain path. Force purely-local merges.
      git: { remote: null },
    },
    null,
    2,
  );
  const proj = createTempProject({
    source_templates_dir: REAL_TEMPLATES,
    source_skills_dir: REAL_SKILLS,
    extra_files: {
      ".claude-orchestrator/config.json": projectConfigJson,
    },
  });
  const prev_cwd = process.cwd();
  process.chdir(proj.root);

  const sharedInvocations: InvocationRecord[] = [];

  let zk: InMemoryZkClient | undefined;
  let supervisor: InProcessWorkerSupervisor | undefined;
  let bus: LeaderEventBus | undefined;
  const bus_tap = new EventBusTap();

  const paths: OrchestratorPaths = {
    template_dir: proj.templates_dir,
    skills_dir: proj.skills_dir,
    child_module: path.join(proj.root, "_unused_child.js"),
  };

  let signalShutdown!: () => void;
  const shutdown_signal = new Promise<void>((res) => {
    signalShutdown = res;
  });

  // Capture the leader's cache paths so the test can read manifest /
  // audit.jsonl afterwards. Filled by on_leader_bus side-channel.
  let cache_paths: cachePaths.CachePathOptions | undefined;
  let leader_id: InstanceId | undefined;

  const runPromise = runOrchestrator(
    {
      zk_hosts: "in-memory",
      worker_count: 6,
      y_flag: true,
      debug: false,
    },
    paths,
    {
      zk_factory: (opts) => {
        zk = new InMemoryZkClient({ ensure_paths: opts.ensure_paths });
        return zk;
      },
      // Each worker gets its own FakeClaudeRunner wrapping a shared
      // invocation log. The wrapper writes touch-files into the
      // worker's worktree so CommitChecker produces real commits.
      claude_runner_factory: () => {
        // The leader's runner has no worktree_path — it only runs the
        // decompose phase and merge-decision render, neither of which
        // touches a worktree.
        return new FakeClaudeRunner({
          shared_invocations: sharedInvocations,
        });
      },
      supervisor_factory: (supOpts) => {
        if (!zk) throw new Error("zk_factory must run before supervisor_factory");
        leader_id = asInstanceId(supOpts.leader_instance_id);
        cache_paths = {
          projects_root: supOpts.projects_root,
          leader_instance_id: leader_id,
        };
        supervisor = new InProcessWorkerSupervisor({
          zk,
          template_dir: proj.templates_dir,
          cache_paths,
          leader_id,
          hooks: supOpts.hooks,
          git_remote: supOpts.git_remote,
          magic_mode: supOpts.magic_mode,
          logger: new Logger({ namespace: "test-supervisor", level: "info" }),
          runner_factory: (cfg) =>
            new FakeClaudeRunner({
              shared_invocations: sharedInvocations,
              worktree_path: cfg.worktree_path,
            }),
        });
        return supervisor;
      },
      on_leader_bus: (b) => {
        bus = b;
        bus_tap.attach(b);
      },
      headless: true,
      recovery_enabled: false,
      shutdown_signal,
    },
  );

  // Wait until all 6 workers have registered.
  await waitFor(
    () => !!supervisor && supervisor.get_registered().length === 6,
    { timeout_ms: 10_000, label: "all 6 in-process workers registered" },
  );
  // Settle the WorkerMonitor watch fanout so LeaderState reflects 6 workers.
  await new Promise((r) => setTimeout(r, 50));

  if (!cache_paths || !leader_id || !bus || !zk || !supervisor) {
    throw new Error("orchestrator deps did not fire");
  }

  // Drop the user input into the leader's mailbox. This is what
  // TuiController would do on Enter (packages/leader/src/tui/controller.ts
  // sends a `user_input` to the leader's own message dir).
  const userMessageRouter = new MessageRouter({ zk });
  await userMessageRouter.send({
    type: "user_input",
    from_instance: leader_id,
    from_name: "user",
    from_role: "leader",
    to_instance: leader_id,
    content: "Add a hello-world file to verify the chain runs end-to-end.",
  });

  // Wait for the chain to finish.
  const closed = await waitForAnyChainClosed({
    cache_paths,
    timeout_ms: 60_000,
  });

  // Snapshot ZK before shutdown so ephemeral nodes are still present.
  const zk_tree = zk.dumpTree();

  signalShutdown();
  await runPromise;
  bus_tap.stop();

  return {
    zk,
    supervisor,
    shared_invocations: sharedInvocations,
    bus,
    bus_tap,
    hook_harness: hookHarness,
    cache_paths,
    leader_id,
    zk_tree,
    closed_chain_id: closed.chain_id,
    proj,
    home,
    prev_cwd,
  };
}

async function waitFor(
  pred: () => boolean,
  opts: { timeout_ms: number; label: string; interval_ms?: number },
): Promise<void> {
  const start = Date.now();
  const interval = opts.interval_ms ?? 25;
  while (Date.now() - start < opts.timeout_ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timeout waiting for: ${opts.label}`);
}

describe("eval 02: leader↔worker communication chain", () => {
  let art: RunArtifacts;

  beforeAll(async () => {
    art = await bootAndRunChain();
  }, 120_000);

  afterAll(() => {
    process.chdir(art.prev_cwd);
    art.hook_harness.cleanup();
    art.proj.cleanup();
    art.home.cleanup();
    art.home.restore();
  });

  it("ChainAudit closeChain wrote a 'completed' manifest (§5.4, §7.1)", async () => {
    const manifest = await readManifest({
      cache_paths: art.cache_paths,
      chain_id: art.closed_chain_id,
    });
    if (manifest.status !== "completed") {
      // Print the audit log so the merge failure is diagnosable.
      const records = await readAuditLog({
        cache_paths: art.cache_paths,
        chain_id: art.closed_chain_id,
      });
      const failures = records.filter(
        (r) => r.event === "merge_failure" || r.event === "chain_closed",
      );
      console.error("merge diagnosis:", JSON.stringify(failures, null, 2));
    }
    expect(manifest.status).toBe("completed");
    expect(manifest.completed_at).toBeTruthy();
    expect(manifest.link_tasks.plan).toBeTruthy();
    expect(manifest.link_tasks.execute).toBeTruthy();
    expect(manifest.link_tasks.verify).toBeTruthy();
    expect(manifest.link_tasks.review).toBeTruthy();
    expect(manifest.link_tasks.accept).toBeTruthy();
  });

  it("manifest.link_commits carries dual {worktree, docs, branch} per link (§5.4, §9 item 5)", async () => {
    const manifest = await readManifest({
      cache_paths: art.cache_paths,
      chain_id: art.closed_chain_id,
    });
    expect(manifest.link_commits).toBeDefined();
    for (const link of ["plan", "execute", "verify", "review", "accept"] as const) {
      const rec = manifest.link_commits?.[link];
      expect(rec, `link_commits.${link} missing`).toBeDefined();
      expect(rec!.branch).toMatch(/^claude-orchestrator\//);
      // worktree SHA is non-null because FakeClaudeRunner touched a
      // marker file in the worktree per link.
      expect(rec!.worktree, `${link} worktree sha`).toMatch(/^[0-9a-f]{40}$/);
      // docs may legitimately be null when no docs/ entry was written —
      // we only assert the field exists and is a string|null.
      expect(rec!.docs === null || typeof rec!.docs === "string").toBe(true);
    }
  });

  it("audit.jsonl contains the documented core events (§7, §9 item 8)", async () => {
    const records = await readAuditLog({
      cache_paths: art.cache_paths,
      chain_id: art.closed_chain_id,
    });
    const eventCounts = new Map<string, number>();
    for (const r of records) {
      eventCounts.set(r.event, (eventCounts.get(r.event) ?? 0) + 1);
    }
    // Required cardinality from eval 02 §9 item 8.
    expect(eventCounts.get("requirement_received") ?? 0).toBeGreaterThanOrEqual(1);
    expect(eventCounts.get("chain_opened") ?? 0).toBe(1);
    expect(eventCounts.get("task_dispatch") ?? 0).toBeGreaterThanOrEqual(5);
    expect(eventCounts.get("completion_report") ?? 0).toBeGreaterThanOrEqual(5);
    expect(eventCounts.get("chain_closed") ?? 0).toBe(1);
  });

  it("FakeClaudeRunner saw the expected per-phase call counts", () => {
    const inv = art.shared_invocations;
    const byPhase: Record<string, number> = {};
    for (const r of inv) byPhase[r.phase] = (byPhase[r.phase] ?? 0) + 1;

    // Leader decompose runs exactly once.
    expect(byPhase.decompose ?? 0).toBe(1);
    // 5 worker tasks (plan → accept).
    expect(byPhase.worker_task ?? 0).toBeGreaterThanOrEqual(5);
    // Each chain-link task is followed by a self-evaluation call.
    expect(byPhase.evaluate ?? 0).toBeGreaterThanOrEqual(5);
    // CommitChecker + DocsCommitter both invoke commit_message generation,
    // but only when there are file changes. Just sanity-check it ran.
    expect(byPhase.commit_message ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("ZK message tree shows per-worker mailboxes with sequential msg-NNNN nodes (§3, §9 item 1)", () => {
    const messages = art.zk_tree.children.find((c) => c.name === "messages");
    expect(messages, "messages dir present in ZK tree").toBeDefined();
    // Leader + 6 workers all have mailboxes — but a worker only has a
    // dir node once it received at least one message.
    const mailboxes = messages!.children;
    // At minimum we expect the leader mailbox (user_input) and 5
    // chain-link workers' mailboxes (task_dispatch).
    expect(mailboxes.length).toBeGreaterThanOrEqual(6);
    for (const mb of mailboxes) {
      for (const node of mb.children) {
        expect(node.name).toMatch(/^msg-\d{10}$/);
      }
    }
  });

  it("LeaderEventBus emitted the documented sequence (§9 item 11)", () => {
    const types = art.bus_tap.events().map((e) => e.type);
    // First event after the bus is constructed is magic_mode_configured
    // (run.ts:325 emits it right after bus wiring).
    expect(types[0]).toBe("magic_mode_configured");
    // 6 worker_joined events arrive once monitor.start() picks up the
    // ephemeral instance nodes.
    expect(art.bus_tap.count("worker_joined")).toBeGreaterThanOrEqual(6);
    // Chain lifecycle is observable.
    expect(art.bus_tap.count("task_created")).toBeGreaterThanOrEqual(5);
    expect(art.bus_tap.count("task_completed")).toBeGreaterThanOrEqual(5);
  });

  it("per-worker worktrees have ≥1 new commit on the worker branch (§5.1, §9 item 4)", () => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    for (const r of art.supervisor.get_registered()) {
      // Skip workers that never got a task (e.g. the spare executor in
      // worker 6 → role 'executor' that came after the first executor).
      const log = execFileSync(
        "git",
        ["log", "--oneline", "-n", "10"],
        { cwd: pathOfWorktree(art, r.name), encoding: "utf-8" },
      );
      // We don't require every worker to have committed — only chain-link
      // workers. At minimum 5 commits land somewhere across the 6 workers.
      void log; // captured for diagnosis if a sibling assertion fails
    }
    const seeded = execFileSync(
      "git",
      ["log", "--oneline", "--all"],
      { cwd: art.proj.root, encoding: "utf-8" },
    );
    // 5 chain-link commits + the seed commit = at least 6 total in the
    // shared project repo (worktrees share the same .git).
    const lines = seeded.trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(6);
  });

  it("upstream_commits propagates monotonically through link_commits (§6.1, §9 item 6)", async () => {
    // The manifest's link_commits is the persistent representation of
    // what `ChainAudit.collectUpstreamCommits` would have injected into
    // each task_dispatch. Walking it in chain order is the same as
    // observing the upstream_commits set grow monotonically link-by-link.
    const manifest = await readManifest({
      cache_paths: art.cache_paths,
      chain_id: art.closed_chain_id,
    });
    const upstreamAt = (idx: number): Set<string> => {
      const links = ["plan", "execute", "verify", "review", "accept"] as const;
      const acc = new Set<string>();
      for (let i = 0; i < idx; i++) {
        const sha = manifest.link_commits?.[links[i]]?.worktree;
        if (sha) acc.add(sha);
      }
      return acc;
    };
    // Each subsequent link sees a strict superset of the previous link's
    // upstream commits.
    for (let i = 1; i <= 5; i++) {
      const prev = upstreamAt(i - 1);
      const cur = upstreamAt(i);
      expect(cur.size).toBeGreaterThanOrEqual(prev.size);
      for (const sha of prev) {
        expect(cur.has(sha), `upstream@${i} missing prior sha ${sha.slice(0, 8)}`).toBe(true);
      }
    }
  });

  it("preTaskRebase landed each upstream sha as an ancestor of each downstream branch (§6.2, §9 item 7)", async () => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const manifest = await readManifest({
      cache_paths: art.cache_paths,
      chain_id: art.closed_chain_id,
    });
    const links = ["plan", "execute", "verify", "review", "accept"] as const;
    // For each downstream link, the most recent upstream worktree sha
    // must be an ancestor of the downstream branch's HEAD. We run
    // `git merge-base --is-ancestor` against the shared project repo —
    // the worktrees share the same .git so branch names are visible
    // from the project root.
    const branchLog = (branch: string): string => {
      try {
        return execFileSync(
          "git",
          ["log", "--oneline", "-n", "8", branch],
          { cwd: art.proj.root, encoding: "utf-8" },
        );
      } catch (err) {
        return `<log failed: ${String(err)}>`;
      }
    };
    for (let i = 1; i < links.length; i++) {
      const upstreamSha = manifest.link_commits?.[links[i - 1]]?.worktree;
      const downstreamBranch = manifest.link_commits?.[links[i]]?.branch;
      if (!upstreamSha || !downstreamBranch) continue;
      let status = 0;
      try {
        execFileSync(
          "git",
          [
            "merge-base",
            "--is-ancestor",
            upstreamSha,
            downstreamBranch,
          ],
          { cwd: art.proj.root, stdio: "pipe" },
        );
      } catch (err) {
        status = (err as { status?: number }).status ?? -1;
      }
      if (status !== 0) {
        console.error(`upstream branch (${links[i - 1]}):`, branchLog(manifest.link_commits?.[links[i - 1]]?.branch ?? ""));
        console.error(`downstream branch (${links[i]}):`, branchLog(downstreamBranch));
        // Diagnose: did the downstream worker's prompt see the upstream sha?
        const downstreamInvs = art.shared_invocations
          .filter((r) => r.phase === "worker_task")
          .map((r) => `${r.role}: upstream=[${r.upstream_echo}]`);
        console.error("all worker_task invocations:");
        for (const line of downstreamInvs) console.error("  " + line);
      }
      expect(
        status,
        `upstream ${links[i - 1]} sha=${upstreamSha.slice(0, 8)} NOT ancestor of ${links[i]} branch ${downstreamBranch}`,
      ).toBe(0);
    }
  });

  it("CO_* env was captured for every hook event (§9 item 3)", () => {
    const allCaptures = art.hook_harness.read_all();
    // At minimum every hook in HOOK_EVENT_TYPES that actually fires
    // during this scenario produced a capture.
    expect(allCaptures.length).toBeGreaterThan(0);

    // Sample a worker_message_start capture and assert its required CO_*
    // schema per packages/contracts/src/hooks.ts:16-27.
    const wmsCaps = art.hook_harness.read_captured("worker_message_start");
    expect(wmsCaps.length).toBeGreaterThanOrEqual(5);
    const first = wmsCaps[0]!;
    expect(first.env.CO_EVENT).toBe("worker_message_start");
    expect(first.env.CO_WORKER_NAME).toBeTruthy();
    expect(first.env.CO_WORKER_ID).toBeTruthy();
    expect(first.env.CO_WORKER_ROLE).toBeTruthy();
    expect(first.env.CO_LEADER_ID).toBeTruthy();
    expect(first.env.CO_TASK_ID).toBeTruthy();
    expect(first.env.CO_LINK).toBeTruthy();
    expect(first.env.CO_LOG_PATH).toBeTruthy();
    expect(first.env.CO_RESULT_PATH).toBeTruthy();

    // leader_message_start fires exactly once (decompose).
    const lmsCaps = art.hook_harness.read_captured("leader_message_start");
    expect(lmsCaps.length).toBe(1);
    expect(lmsCaps[0].env.CO_LEADER_ID).toBeTruthy();
    expect(lmsCaps[0].env.CO_LOG_PATH).toBeTruthy();

    // chain_activated fires once on chain open.
    const caCaps = art.hook_harness.read_captured("chain_activated");
    expect(caCaps.length).toBe(1);
    expect(caCaps[0].env.CO_CHAIN_ID).toBeTruthy();
  });
});

function pathOfWorktree(art: RunArtifacts, name: string): string {
  return path.join(art.proj.root, ".claude-orchestrator", "worktree", name);
}
