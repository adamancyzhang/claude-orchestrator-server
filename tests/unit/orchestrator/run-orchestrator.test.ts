import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runPhases, type OrchDeps, type RunConfig } from "../../../src/orchestrator/phases.js";
import type { WorktreeConfig } from "../../../src/worker/worktree-initializer.js";

function fakeChild(): EventEmitter & {
  exitCode: number | null;
  killed: boolean;
  kill: (sig?: string) => void;
} {
  const e = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    killed: boolean;
    kill: (sig?: string) => void;
  };
  e.exitCode = null;
  e.killed = false;
  e.kill = vi.fn(() => { e.killed = true; });
  return e;
}

function makeWorktrees(n: number): WorktreeConfig[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `W${i}`,
    role: "builder",
    worktreePath: `/tmp/wt/W${i}`,
    relativePath: `.claude-orchestrator/worktree/W${i}`,
    branch: `claude-orchestrator/W${i}-workspace`,
    instanceId: `inst-${i}`,
  }));
}

const baseConfig: RunConfig = {
  zkHosts: "127.0.0.1:2181",
  workerCount: 3,
  templateDir: "/tmp/templates",
  skillsDir: "/tmp/skills",
  projectRoot: "/tmp/proj",
  cliCommand: "claude",
  cacheDir: "/tmp/cache",
  debug: false,
  yFlag: true,
};

function makeDeps(over: Partial<OrchDeps> = {}): OrchDeps {
  const children: ReturnType<typeof fakeChild>[] = [];
  let resolveSignal: () => void = () => {};
  const signalPromise = new Promise<void>((r) => { resolveSignal = r; });

  const deps: OrchDeps = {
    ensureCleanWorkspace: vi.fn(() => ({ clean: true })),
    runInitCheck: vi.fn(async () => {}),
    commitInitFiles: vi.fn(),
    initializeWorktrees: vi.fn(async (_root: string, n: number) => makeWorktrees(n)),
    startLeader: vi.fn(async () => {}),
    forkWorker: vi.fn((cfg) => {
      const c = fakeChild();
      children.push(c);
      Object.assign(c, { _name: cfg.name });
      return c as unknown as ReturnType<OrchDeps["forkWorker"]>;
    }),
    waitForSignal: vi.fn(() => signalPromise),
    ...over,
  };
  return Object.assign(deps, { __children: children, __resolveSignal: resolveSignal }) as OrchDeps;
}

describe("runPhases — 5-phase orchestration", () => {
  it("executes all phases in order", async () => {
    const deps = makeDeps();
    const promise = runPhases(baseConfig, deps);
    // Resolve the signal so phase 5 completes
    (deps as unknown as { __resolveSignal: () => void }).__resolveSignal();
    const { log } = await promise;
    const phases = log.map((l) => l.phase);
    expect(phases).toEqual([1, 1, 1, 2, 3, 4, 5]);
    expect(log.every((l) => l.ok)).toBe(true);
  });

  it("phase 1 fails fast when workspace is dirty", async () => {
    const deps = makeDeps({
      ensureCleanWorkspace: vi.fn(() => ({ clean: false, status: " M dirty.txt" })),
    });
    await expect(runPhases(baseConfig, deps)).rejects.toThrow(/uncommitted/);
    expect(deps.initializeWorktrees).not.toHaveBeenCalled();
  });

  it("phase 2 forwards workerCount to initializeWorktrees", async () => {
    const deps = makeDeps();
    const promise = runPhases({ ...baseConfig, workerCount: 5 }, deps);
    (deps as unknown as { __resolveSignal: () => void }).__resolveSignal();
    await promise;
    expect(deps.initializeWorktrees).toHaveBeenCalledWith("/tmp/proj", 5);
  });

  it("phase 4 forks one child per worktree", async () => {
    const deps = makeDeps();
    const promise = runPhases({ ...baseConfig, workerCount: 3 }, deps);
    (deps as unknown as { __resolveSignal: () => void }).__resolveSignal();
    await promise;
    expect(deps.forkWorker).toHaveBeenCalledTimes(3);
  });

  it("phase 4 restarts a worker up to 3 times when it crashes", async () => {
    const deps = makeDeps({ initializeWorktrees: vi.fn(async () => makeWorktrees(1)) });
    const promise = runPhases({ ...baseConfig, workerCount: 1 }, deps);

    const dexp = deps as unknown as { __children: ReturnType<typeof fakeChild>[]; __resolveSignal: () => void };
    // Wait for first child to be forked
    await new Promise((r) => setImmediate(r));
    expect(dexp.__children).toHaveLength(1);

    // Crash 3 times in a row
    for (let i = 0; i < 3; i++) {
      const last = dexp.__children[dexp.__children.length - 1];
      last.emit("exit", 1, null);
      await new Promise((r) => setImmediate(r));
    }
    // Should have forked 4 times total (initial + 3 restarts)
    expect(deps.forkWorker).toHaveBeenCalledTimes(4);

    // 4th crash should NOT trigger a 5th fork (max retries reached)
    dexp.__children[dexp.__children.length - 1].emit("exit", 1, null);
    await new Promise((r) => setImmediate(r));
    expect(deps.forkWorker).toHaveBeenCalledTimes(4);

    dexp.__resolveSignal();
    await promise;
  });

  it("on shutdown, sends SIGTERM to all alive children", async () => {
    const deps = makeDeps();
    const promise = runPhases({ ...baseConfig, workerCount: 2 }, deps);
    const dexp = deps as unknown as { __children: ReturnType<typeof fakeChild>[]; __resolveSignal: () => void };
    await new Promise((r) => setImmediate(r));
    dexp.__resolveSignal();
    await promise;
    for (const c of dexp.__children) {
      expect(c.kill).toHaveBeenCalledWith("SIGTERM");
    }
  });

  it("respects yFlag → runInitCheck called with the flag", async () => {
    const deps = makeDeps();
    const promise = runPhases({ ...baseConfig, yFlag: true }, deps);
    (deps as unknown as { __resolveSignal: () => void }).__resolveSignal();
    await promise;
    expect(deps.runInitCheck).toHaveBeenCalledWith(expect.objectContaining({ yFlag: true }));
  });

  it("phase order: initializeWorktrees runs after init-check", async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      runInitCheck: vi.fn(async () => { callOrder.push("init"); }),
      initializeWorktrees: vi.fn(async (_r: string, n: number) => {
        callOrder.push("worktrees");
        return makeWorktrees(n);
      }),
      startLeader: vi.fn(async () => { callOrder.push("leader"); }),
      forkWorker: vi.fn((cfg) => {
        callOrder.push(`worker-${cfg.name}`);
        const c = fakeChild();
        return c as unknown as ReturnType<OrchDeps["forkWorker"]>;
      }),
    });
    const promise = runPhases(baseConfig, deps);
    (deps as unknown as { __resolveSignal: () => void }).__resolveSignal();
    await promise;
    expect(callOrder.indexOf("init")).toBeLessThan(callOrder.indexOf("worktrees"));
    expect(callOrder.indexOf("worktrees")).toBeLessThan(callOrder.indexOf("leader"));
    expect(callOrder.indexOf("leader")).toBeLessThan(callOrder.indexOf("worker-W0"));
  });
});
