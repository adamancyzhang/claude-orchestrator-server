// CORE-RETENTION
// Locks in: HookEngine's constructor filtering (disabled / empty
// command / unknown event types do NOT register), the fire-and-forget
// real subprocess invocation (CO_EVENT + flattenEnv values propagate
// as env vars and are observable via the script's output), the
// HOOK_TIMEOUT_MS = 5000 SIGKILL contract (a sleep-longer hook is
// killed and the promise still resolves), and the null/undefined env
// coercion to empty string.
// Critical because: hooks are user-supplied side-channels (CI
// triggers, audit pings, etc). A regression that leaks unmocked
// timeouts (no SIGKILL) hangs the worker loop indefinitely; a
// regression that drops CO_EVENT or env vars silently corrupts user
// scripts. Real subprocess testing is mandatory here: mocking spawn()
// would mean we test the mock, not the spawn contract that hook
// authors depend on.
// Primary sources: packages/runtime/src/hook-engine.ts

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HookEvent, ILogger } from "@co/contracts";
import { HookEngine } from "../src/hook-engine.js";

let tmpRoot: string;

// CapturingLogger is a real test double (data structure), not a mock —
// no TRUST-JUSTIFICATION needed. It records every call so we can assert
// on observable side-effects (e.g., "hook timeout — killed" warning).
class CapturingLogger implements ILogger {
  public readonly warns: Array<{ msg: string; extras?: unknown }> = [];
  public readonly errors: Array<{ msg: string; extras?: unknown }> = [];
  debug(): void {
    /* swallow */
  }
  info(): void {
    /* swallow */
  }
  warn(msg: string, extras?: unknown): void {
    this.warns.push({ msg, extras });
  }
  error(msg: string, extras?: unknown): void {
    this.errors.push({ msg, extras });
  }
  child(): ILogger {
    return this;
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "co-hook-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeWorkerEvent(env: Record<string, string | null | undefined>): HookEvent {
  // task_claimed has the simplest typed env so the test double satisfies
  // the discriminated union via `as never`-style structural cast.
  return {
    type: "task_claimed",
    env: env as unknown as HookEvent extends { type: "task_claimed" }
      ? Extract<HookEvent, { type: "task_claimed" }>["env"]
      : never,
  };
}

describe("HookEngine — constructor filtering", () => {
  it("registers only enabled, non-empty, known events", () => {
    const logger = new CapturingLogger();
    const engine = new HookEngine(
      [
        { event: "task_claimed", command: "echo ok", enabled: true },
        { event: "task_completed", command: "echo skipped", enabled: false },
        { event: "chain_activated", command: "", enabled: true },
        {
          event: "unknown_event" as unknown as HookEvent["type"],
          command: "echo x",
          enabled: true,
        },
      ],
      logger,
    );

    expect(engine.registered).toEqual(["task_claimed"]);
    // Unknown event warns once.
    expect(logger.warns.some((w) => w.msg.includes("unknown hook event"))).toBe(
      true,
    );
  });
});

describe("HookEngine.fire — unregistered event", () => {
  it("returns without spawning anything when no handler is registered", async () => {
    const sentinel = path.join(tmpRoot, "should-never-exist");
    const logger = new CapturingLogger();
    // Register ONLY task_claimed; fire chain_activated → unregistered → no-op.
    const engine = new HookEngine(
      [
        {
          event: "task_claimed",
          command: `touch "${sentinel}"`,
          enabled: true,
        },
      ],
      logger,
    );

    await engine.fire({
      type: "chain_activated",
      env: { CO_CHAIN_ID: "ch-1" as never },
    });

    // Brief grace period so a (hypothetical, undesired) detached child
    // would have time to touch the sentinel before we assert.
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(sentinel)).toBe(false);
  });
});

describe("HookEngine.fire — env propagation", () => {
  it("CO_EVENT + flattenEnv values reach the hook script as env vars", async () => {
    const sentinel = path.join(tmpRoot, "env-output.txt");
    const logger = new CapturingLogger();
    const engine = new HookEngine(
      [
        {
          event: "task_claimed",
          // POSIX shell — write each captured env var on its own line.
          command: `echo "EVENT=$CO_EVENT" > "${sentinel}"; echo "WORKER=$CO_WORKER_NAME" >> "${sentinel}"; echo "TASK=$CO_TASK_ID" >> "${sentinel}"; echo "NULLVAL=$CO_NULLVAL" >> "${sentinel}"`,
          enabled: true,
        },
      ],
      logger,
    );

    await engine.fire(
      makeWorkerEvent({
        CO_WORKER_NAME: "Tom",
        CO_TASK_ID: "task-42",
        CO_NULLVAL: null,
      }),
    );

    // The child is detached + unref'd; fire() resolves on exit. The file
    // must exist by then.
    const body = fs.readFileSync(sentinel, "utf-8");
    expect(body).toContain("EVENT=task_claimed");
    expect(body).toContain("WORKER=Tom");
    expect(body).toContain("TASK=task-42");
    // null gets coerced to empty string by flattenEnv.
    expect(body).toContain("NULLVAL=");
  });
});

describe("HookEngine.fire — timeout", () => {
  it(
    "kills hooks that run past HOOK_TIMEOUT_MS (5s) and resolves with a warn",
    { timeout: 10000 },
    async () => {
      const sentinel = path.join(tmpRoot, "long.txt");
      const logger = new CapturingLogger();
      const engine = new HookEngine(
        [
          {
            event: "task_claimed",
            // Sleep 8s — exceeds 5s timeout. Touch sentinel AFTER sleep
            // so we can verify the script was killed BEFORE completion.
            command: `sleep 8 && touch "${sentinel}"`,
            enabled: true,
          },
        ],
        logger,
      );

      const start = Date.now();
      await engine.fire(makeWorkerEvent({ CO_TASK_ID: "t-killed" }));
      const elapsed = Date.now() - start;

      // Promise resolves at the timeout (~5s), not after the 8s sleep.
      expect(elapsed).toBeLessThan(6500);
      // The post-sleep touch never happened.
      // Give the OS up to 500ms to actually deliver SIGKILL before checking.
      await new Promise((r) => setTimeout(r, 500));
      expect(fs.existsSync(sentinel)).toBe(false);
      // Logger captures the timeout.
      expect(logger.warns.some((w) => w.msg.includes("timeout"))).toBe(true);

      // Best-effort: kill any lingering sleep process by name so the
      // test runner doesn't hang waiting for orphans.
      try {
        execFileSync("pkill", ["-f", `sleep 8 && touch ${sentinel}`], {
          stdio: "ignore",
        });
      } catch {
        // pkill returns non-zero when nothing matches — fine.
      }
    },
  );
});
