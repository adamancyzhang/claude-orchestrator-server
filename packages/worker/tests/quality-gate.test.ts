import { describe, it, expect, beforeEach, vi } from "vitest";
import { QualityGateExecutor, type QualityGateResult } from "../src/quality-gate.js";
import type { QualityGate } from "@co/contracts";

describe("QualityGateExecutor", () => {
  let executor: QualityGateExecutor;

  beforeEach(() => {
    executor = new QualityGateExecutor();
  });

  describe("test gate", () => {
    it("should pass when no commands specified", async () => {
      const gate: QualityGate = {
        type: "test",
        criteria: "tests pass",
        commands: [],
      };

      const result = await executor.execute(gate, "/tmp");
      expect(result.passed).toBe(true);
      expect(result.gate_type).toBe("test");
      expect(result.message).toContain("No test commands specified");
    });

    it("should pass when command succeeds", async () => {
      const gate: QualityGate = {
        type: "test",
        criteria: "tests pass",
        commands: ["echo 'hello'"],
      };

      const result = await executor.execute(gate, "/tmp");
      expect(result.passed).toBe(true);
      expect(result.gate_type).toBe("test");
      expect(result.message).toContain("passed");
    });

    it("should fail when command fails", async () => {
      const gate: QualityGate = {
        type: "test",
        criteria: "tests pass",
        commands: ["exit 1"],
      };

      const result = await executor.execute(gate, "/tmp");
      expect(result.passed).toBe(false);
      expect(result.gate_type).toBe("test");
      expect(result.message).toContain("Command failed");
      expect(result.message).toContain("Exit code: 1");
    });
  });

  describe("self_eval gate", () => {
    it("should return criteria message", async () => {
      const gate: QualityGate = {
        type: "self_eval",
        criteria: "code follows best practices",
      };

      const result = await executor.execute(gate, "/tmp");
      expect(result.passed).toBe(true);
      expect(result.gate_type).toBe("self_eval");
      expect(result.message).toContain("Self-evaluation criteria");
      expect(result.message).toContain("code follows best practices");
    });
  });

  describe("review gate", () => {
    it("should return pending state with requires_async", async () => {
      const gate: QualityGate = {
        type: "review",
        criteria: "code review",
        reviewer_prompt: "Review the code for security issues",
      };

      const result = await executor.execute(gate, "/tmp");
      expect(result.passed).toBe(true);
      expect(result.gate_type).toBe("review");
      expect(result.requires_async).toBe(true);
      expect(result.message).toContain("Review pending");
    });
  });

  describe("accept gate", () => {
    it("should return pending state with requires_async", async () => {
      const gate: QualityGate = {
        type: "accept",
        criteria: "acceptance",
        acceptor_prompt: "Accept if all requirements are met",
      };

      const result = await executor.execute(gate, "/tmp");
      expect(result.passed).toBe(true);
      expect(result.gate_type).toBe("accept");
      expect(result.requires_async).toBe(true);
      expect(result.message).toContain("Accept pending");
    });
  });
});
