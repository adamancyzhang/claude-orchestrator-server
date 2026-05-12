import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HookEngine } from "../../src/hooks/engine.js";
import type { HookContext } from "../../src/hooks/engine.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-test-"));

function makeCtx(overrides?: Partial<HookContext>): HookContext {
  return {
    instanceId: "test-instance-1",
    instanceName: "TestWorker",
    instanceRole: "builder",
    messageId: "msg-0000000001",
    messageType: "direct",
    messageContent: "Please implement the login API.",
    fromInstance: "leader-abc123",
    fromName: "TestLeader",
    toInstance: "test-instance-1",
    workDir: tmpDir,
    link: "build",
    ...overrides,
  };
}

describe("HookEngine", () => {
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads hooks from config and ignores null values", () => {
    const engine = new HookEngine();
    engine.load({
      leader_message_start: "echo start",
      leader_message_end: null,
      worker_message_start: "",
      worker_message_end: "echo end",
    });

    expect(engine.registered).toContain("leader_message_start");
    expect(engine.registered).toContain("worker_message_end");
    expect(engine.registered).not.toContain("leader_message_end");
    expect(engine.registered).not.toContain("worker_message_start");
  });

  it("fire writes environment variables to a temp file", async () => {
    const outputFile = path.join(tmpDir, "hook-output.txt");
    const engine = new HookEngine();

    engine.load({
      worker_message_start: `env | grep ^CO_ | sort > '${outputFile}'`,
    });

    engine.fire("worker_message_start", makeCtx());

    // Hook runs async, wait a bit
    await new Promise((r) => setTimeout(r, 300));

    expect(fs.existsSync(outputFile)).toBe(true);
    const content = fs.readFileSync(outputFile, "utf-8");

    expect(content).toContain("CO_HOOK_EVENT=worker_message_start");
    expect(content).toContain("CO_INSTANCE_ID=test-instance-1");
    expect(content).toContain("CO_INSTANCE_NAME=TestWorker");
    expect(content).toContain("CO_INSTANCE_ROLE=builder");
    expect(content).toContain("CO_MESSAGE_ID=msg-0000000001");
    expect(content).toContain("CO_MESSAGE_TYPE=direct");
    expect(content).toContain("CO_MESSAGE_CONTENT=Please implement the login API.");
    expect(content).toContain("CO_FROM_INSTANCE=leader-abc123");
    expect(content).toContain("CO_FROM_NAME=TestLeader");
    expect(content).toContain("CO_TO_INSTANCE=test-instance-1");
    expect(content).toContain("CO_WORK_DIR=" + tmpDir);
    expect(content).toContain("CO_LINK=build");
    // end-only fields should be empty for start hook
    expect(content).toContain("CO_LOG_PATH=");
    expect(content).toContain("CO_EXIT_CODE=");
  });

  it("fire passes logPath and exitCode for end hooks", async () => {
    const outputFile = path.join(tmpDir, "hook-end-output.txt");
    const engine = new HookEngine();

    engine.load({
      worker_message_end: `env | grep -E 'CO_LOG_PATH|CO_EXIT_CODE' | sort > '${outputFile}'`,
    });

    engine.fire("worker_message_end", makeCtx({ logPath: "/tmp/test.log", exitCode: 0 }));

    await new Promise((r) => setTimeout(r, 300));

    const content = fs.readFileSync(outputFile, "utf-8");
    expect(content).toContain("CO_LOG_PATH=/tmp/test.log");
    expect(content).toContain("CO_EXIT_CODE=0");
  });

  it("fire is a no-op when no hook registered for event", () => {
    const engine = new HookEngine();
    // No hooks loaded at all — should not throw
    expect(() => engine.fire("leader_message_start", makeCtx())).not.toThrow();
  });

  it("handles invalid shell commands gracefully", async () => {
    const engine = new HookEngine();
    engine.load({
      leader_message_start: "nonexistent-command-xyz 2>/dev/null",
    });

    // Should not throw — hook errors are caught and logged
    expect(() => engine.fire("leader_message_start", makeCtx())).not.toThrow();
    await new Promise((r) => setTimeout(r, 100));
  });
});
