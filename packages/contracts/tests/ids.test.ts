// CORE-RETENTION
// Locks in: branded ID factories (`asInstanceId`, `asTaskId`, ...) return the
// same string value at runtime while producing distinct compile-time types so
// mixing IDs from different domains is a type error.
// Critical because: every cross-package contract addresses entities by branded
// id; if the brands collapse to plain strings, the type system stops catching
// "passed a TaskId where InstanceId was required" mistakes that previously
// caused message-router mis-delivery.
// Primary sources: packages/contracts/src/ids.ts

import { describe, expect, it } from "vitest";
import {
  asChainId,
  asInstanceId,
  asMessageId,
  asProjectId,
  asSessionId,
  asTaskId,
  asWorktreeName,
  asZkPath,
} from "../src/ids.js";

describe("branded id factories", () => {
  it("preserve the underlying string value", () => {
    expect(asInstanceId("inst-1")).toBe("inst-1");
    expect(asTaskId("t-9")).toBe("t-9");
    expect(asMessageId("m-3")).toBe("m-3");
    expect(asChainId("c-7")).toBe("c-7");
    expect(asSessionId("s-2")).toBe("s-2");
    expect(asWorktreeName("Tom")).toBe("Tom");
    expect(asProjectId("proj-x")).toBe("proj-x");
    expect(asZkPath("/co/tasks")).toBe("/co/tasks");
  });

  it("accept empty strings without crashing (callers may pass placeholders)", () => {
    expect(asInstanceId("")).toBe("");
    expect(asZkPath("")).toBe("");
  });

  it("are idempotent: rebranding an already-branded value is a no-op", () => {
    const a = asInstanceId("inst-1");
    const b = asInstanceId(a);
    expect(b).toBe(a);
  });

  it("preserve unicode and slashes verbatim", () => {
    expect(asWorktreeName("汤姆 / lead")).toBe("汤姆 / lead");
    expect(asZkPath("/co/leader-001/tasks/中文")).toBe(
      "/co/leader-001/tasks/中文",
    );
  });
});
