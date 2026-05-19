// TRUST-JUSTIFICATION: In-memory IChildSupervisor used by
// `packages/orchestrator/tests/core/e2e/startup-worker-6.test.ts`.
// Downstream: replaces `ChildSupervisor.spawn()` which forks Node
//   child processes that call `claude-cli`.
// Reason: forking real worker subprocesses would (a) require docker /
//   real ZK for the children to connect, (b) run real `claude-cli` for
//   each job, (c) write to real worktrees. The eval doc
//   `docs/evals/01-startup-worker-6.md §3.4` only asserts that 6 worker
//   ephemeral nodes appear in ZK with the documented payload — exactly
//   what `InstanceRegistry.register(...)` produces. We do that directly
//   to keep the test deterministic and fast.
// Evidence: `packages/orchestrator/src/child-boot.ts:59-68` shows that
//   the real worker boot's first ZK operation is the same
//   `InstanceRegistry.register(...)` call we make here. After that,
//   the worker enters a wait loop on its message dir; without messages
//   it would stay idle. So at the post-startup snapshot, the
//   observable state — ZK ephemeral nodes + LeaderState worker_joined
//   events — is identical between real fork and this fake.

import {
  asInstanceId,
  type IZkClient,
  type ILogger,
  type Instance,
  type InstanceId,
} from "@co/contracts";
import { InstanceRegistry } from "@co/coordination";
import type {
  IChildSupervisor,
} from "../../src/child-supervisor.js";
import type { WorktreeConfig } from "../../src/worktree-initializer.js";

export interface FakeChildSupervisorOptions {
  /** The same fake ZK the leader uses, so registrations are observable. */
  zk: IZkClient;
  logger: ILogger;
  /** Starting fake PID for worker[0]; subsequent workers get pid+1, etc. */
  base_pid?: number;
  /** Resolves when all fake workers have registered. */
  on_all_joined?: () => void;
}

export class FakeChildSupervisor implements IChildSupervisor {
  private readonly registry: InstanceRegistry;
  private readonly registered: Array<{ id: InstanceId; name: string }> = [];

  constructor(private readonly opts: FakeChildSupervisorOptions) {
    this.registry = new InstanceRegistry({ zk: opts.zk });
  }

  async start(configs: readonly WorktreeConfig[]): Promise<void> {
    const basePid = this.opts.base_pid ?? 9000;
    const joined: Instance[] = [];
    for (let i = 0; i < configs.length; i++) {
      const cfg = configs[i];
      const instance = await this.registry.register({
        id: asInstanceId(cfg.instance_id),
        name: cfg.name,
        role: cfg.role,
        pid: basePid + i,
        work_dir: cfg.worktree_path,
        worktree_path: cfg.worktree_path,
        worktree_branch: cfg.branch,
      });
      joined.push(instance);
      this.registered.push({ id: instance.id, name: instance.name });
      this.opts.logger.info(`fake worker ${cfg.name} registered`, {
        id: instance.id,
        role: cfg.role,
      });
    }
    this.opts.on_all_joined?.();
  }

  async shutdown(): Promise<void> {
    // Best-effort unregister — mirrors what worker child-runner does on
    // SIGTERM. Skipped failures are fine; the fake ZK's close() also
    // sweeps ephemeral nodes.
    for (const { id } of this.registered) {
      await this.registry.unregister(id).catch(() => undefined);
    }
  }

  /** Test introspection: who did we register? */
  get_registered(): readonly { id: InstanceId; name: string }[] {
    return this.registered;
  }
}
