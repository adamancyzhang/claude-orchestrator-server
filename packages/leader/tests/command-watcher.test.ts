// CORE-RETENTION
// Locks in: CommandWatcher reads commands.jsonl for new lines, parses JSON,
// and forwards valid "send" commands via messageRouter.send(). Skips malformed
// JSON, non-send commands, and lines missing "content". Tracks file position
// to only process new lines. Uses fs.watch with debounce.
// Critical because: CommandWatcher is the entry point for external commands
// into the leader. A missed or duplicated command means lost user input or
// duplicate messages. Position tracking prevents re-processing old lines
// after restart.
// Primary sources: packages/leader/src/command-watcher.ts

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  asInstanceId,
  type IMessageRouter,
  type SendMessageInput,
  type Message,
} from "@co/contracts";
import { CommandWatcher, type CommandWatcherOptions } from "../src/command-watcher.js";

class CapturingMessageRouter implements IMessageRouter {
  public readonly sent: SendMessageInput[] = [];

  async send(input: SendMessageInput): Promise<Message> {
    this.sent.push(input);
    return {
      id: "msg-captured" as Message["id"],
      type: input.type,
      from_instance: input.from_instance,
      from_name: input.from_name,
      to_instance: input.to_instance,
      content: input.content,
      link: null,
      chain_id: null,
      task_id: null,
      task_title: null,
      task_description: null,
      task_criteria: null,
      result_path: null,
      original_requirement_path: null,
      reply_to: null,
      read: false,
      created_at: new Date().toISOString(),
    };
  }

  async poll(): Promise<Message[]> {
    throw new Error("unused");
  }
  async waitForMessage(): Promise<void> {
    throw new Error("unused");
  }
  async ack(): Promise<void> {
    throw new Error("unused");
  }
  async dismiss(): Promise<void> {
    throw new Error("unused");
  }
}

const LEADER_ID = asInstanceId("leader");

function makeOpts(
  stateDir: string,
  router: IMessageRouter,
): CommandWatcherOptions {
  return {
    stateDir,
    messageRouter: router,
    leaderId: LEADER_ID,
    leaderName: "Leader",
  };
}

async function waitDebounce(): Promise<void> {
  // Wait long enough for the 100ms debounce to fire and resolve.
  await new Promise((r) => setTimeout(r, 250));
}

describe("CommandWatcher", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "cw-test-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("does not process lines that existed before start()", async () => {
    writeFileSync(
      join(stateDir, "commands.jsonl"),
      JSON.stringify({ type: "send", content: "old command" }) + "\n",
    );

    const router = new CapturingMessageRouter();
    const watcher = new CommandWatcher(makeOpts(stateDir, router));
    await watcher.start();

    await waitDebounce();
    expect(router.sent).toHaveLength(0);

    watcher.stop();
  });

  it("processes new lines appended after start()", async () => {
    const router = new CapturingMessageRouter();
    const watcher = new CommandWatcher(makeOpts(stateDir, router));
    await watcher.start();

    appendFileSync(
      join(stateDir, "commands.jsonl"),
      JSON.stringify({ type: "send", content: "hello" }) + "\n",
    );

    await waitDebounce();
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0].content).toBe("hello");
    expect(router.sent[0].type).toBe("user_input");
    expect(router.sent[0].from_instance).toBe(LEADER_ID);
    expect(router.sent[0].to_instance).toBe(LEADER_ID);

    watcher.stop();
  });

  it("forwards multiple new lines in a single append", async () => {
    const router = new CapturingMessageRouter();
    const watcher = new CommandWatcher(makeOpts(stateDir, router));
    await watcher.start();

    appendFileSync(
      join(stateDir, "commands.jsonl"),
      [
        JSON.stringify({ type: "send", content: "first" }),
        JSON.stringify({ type: "send", content: "second" }),
      ].join("\n") + "\n",
    );

    await waitDebounce();
    expect(router.sent).toHaveLength(2);
    expect(router.sent[0].content).toBe("first");
    expect(router.sent[1].content).toBe("second");

    watcher.stop();
  });

  it("skips malformed JSON lines", async () => {
    const router = new CapturingMessageRouter();
    const watcher = new CommandWatcher(makeOpts(stateDir, router));
    await watcher.start();

    appendFileSync(
      join(stateDir, "commands.jsonl"),
      "not valid json\n" +
        JSON.stringify({ type: "send", content: "valid" }) + "\n",
    );

    await waitDebounce();
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0].content).toBe("valid");

    watcher.stop();
  });

  it("skips commands with type !== send", async () => {
    const router = new CapturingMessageRouter();
    const watcher = new CommandWatcher(makeOpts(stateDir, router));
    await watcher.start();

    appendFileSync(
      join(stateDir, "commands.jsonl"),
      JSON.stringify({ type: "ping" }) + "\n",
    );

    await waitDebounce();
    expect(router.sent).toHaveLength(0);

    watcher.stop();
  });

  it("skips commands missing content field", async () => {
    const router = new CapturingMessageRouter();
    const watcher = new CommandWatcher(makeOpts(stateDir, router));
    await watcher.start();

    appendFileSync(
      join(stateDir, "commands.jsonl"),
      JSON.stringify({ type: "send" }) + "\n",
    );

    await waitDebounce();
    expect(router.sent).toHaveLength(0);

    watcher.stop();
  });

  it("debounces rapid file changes", async () => {
    const router = new CapturingMessageRouter();
    const watcher = new CommandWatcher(makeOpts(stateDir, router));
    await watcher.start();

    // Append three times quickly.
    appendFileSync(
      join(stateDir, "commands.jsonl"),
      JSON.stringify({ type: "send", content: "a" }) + "\n",
    );
    appendFileSync(
      join(stateDir, "commands.jsonl"),
      JSON.stringify({ type: "send", content: "b" }) + "\n",
    );
    appendFileSync(
      join(stateDir, "commands.jsonl"),
      JSON.stringify({ type: "send", content: "c" }) + "\n",
    );

    await waitDebounce();
    // All three lines processed in one pass despite multiple file events.
    expect(router.sent).toHaveLength(3);
    expect(router.sent.map((s) => s.content)).toEqual(["a", "b", "c"]);

    watcher.stop();
  });

  it("stop() prevents further processing", async () => {
    const router = new CapturingMessageRouter();
    const watcher = new CommandWatcher(makeOpts(stateDir, router));
    await watcher.start();

    watcher.stop();

    appendFileSync(
      join(stateDir, "commands.jsonl"),
      JSON.stringify({ type: "send", content: "after stop" }) + "\n",
    );

    await waitDebounce();
    expect(router.sent).toHaveLength(0);
  });

  it("starts without crashing when commands.jsonl does not exist", async () => {
    const router = new CapturingMessageRouter();
    const watcher = new CommandWatcher(makeOpts(stateDir, router));
    await watcher.start();

    await waitDebounce();
    // No crash, no messages sent.
    expect(router.sent).toHaveLength(0);

    watcher.stop();
  });

  it("handles file created after watcher starts", async () => {
    const router = new CapturingMessageRouter();
    const watcher = new CommandWatcher(makeOpts(stateDir, router));
    await watcher.start();

    // Create the file after the watcher is already running.
    writeFileSync(
      join(stateDir, "commands.jsonl"),
      JSON.stringify({ type: "send", content: "created later" }) + "\n",
    );

    await waitDebounce();
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0].content).toBe("created later");

    watcher.stop();
  });

  it("skips empty lines and whitespace-only lines", async () => {
    const router = new CapturingMessageRouter();
    const watcher = new CommandWatcher(makeOpts(stateDir, router));
    await watcher.start();

    appendFileSync(
      join(stateDir, "commands.jsonl"),
      "\n   \n" +
        JSON.stringify({ type: "send", content: "valid" }) + "\n",
    );

    await waitDebounce();
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0].content).toBe("valid");

    watcher.stop();
  });

  it("skips commands where content is not a string", async () => {
    const router = new CapturingMessageRouter();
    const watcher = new CommandWatcher(makeOpts(stateDir, router));
    await watcher.start();

    appendFileSync(
      join(stateDir, "commands.jsonl"),
      JSON.stringify({ type: "send", content: 123 }) + "\n",
    );

    await waitDebounce();
    expect(router.sent).toHaveLength(0);

    watcher.stop();
  });

  it("handles messageRouter.send failure without crashing", async () => {
    const failingRouter: IMessageRouter = {
      async send(): Promise<Message> {
        throw new Error("send failed");
      },
      async poll(): Promise<Message[]> {
        throw new Error("unused");
      },
      async waitForMessage(): Promise<void> {
        throw new Error("unused");
      },
      async ack(): Promise<void> {
        throw new Error("unused");
      },
      async dismiss(): Promise<void> {
        throw new Error("unused");
      },
    };

    const watcher = new CommandWatcher(makeOpts(stateDir, failingRouter));
    await watcher.start();

    appendFileSync(
      join(stateDir, "commands.jsonl"),
      JSON.stringify({ type: "send", content: "will fail" }) + "\n",
    );

    await waitDebounce();
    // Should not throw despite messageRouter.send() failing.
    watcher.stop();
  });

  it("processes multiple sequential appends", async () => {
    const router = new CapturingMessageRouter();
    const watcher = new CommandWatcher(makeOpts(stateDir, router));
    await watcher.start();

    appendFileSync(
      join(stateDir, "commands.jsonl"),
      JSON.stringify({ type: "send", content: "first" }) + "\n",
    );
    await waitDebounce();
    expect(router.sent).toHaveLength(1);

    appendFileSync(
      join(stateDir, "commands.jsonl"),
      JSON.stringify({ type: "send", content: "second" }) + "\n",
    );
    await waitDebounce();
    expect(router.sent).toHaveLength(2);
    expect(router.sent[1].content).toBe("second");

    watcher.stop();
  });
});
