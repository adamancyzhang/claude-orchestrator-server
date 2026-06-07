import { execSync } from "node:child_process";
import type { QualityGate } from "@co/contracts";

/**
 * Result of executing a quality gate.
 */
export interface QualityGateResult {
  /** Whether the gate passed */
  passed: boolean;
  /** Gate type that was executed */
  gate_type: QualityGate["type"];
  /** Output or error message */
  message: string;
  /** Whether the gate requires async follow-up (review/accept) */
  requires_async?: boolean;
}

/**
 * Executes quality gates for chain tasks.
 *
 * Supports four gate types:
 * - test: Runs shell commands and checks exit codes
 * - self_eval: Evaluates task output against criteria (placeholder for LLM)
 * - review: Returns pending state for async review
 * - accept: Returns pending state for async acceptance
 */
export class QualityGateExecutor {
  /**
   * Execute a quality gate.
   */
  async execute(gate: QualityGate, workDir: string): Promise<QualityGateResult> {
    switch (gate.type) {
      case "test":
        return this.executeTest(gate.commands, workDir);
      case "self_eval":
        return this.executeSelfEval(gate.criteria);
      case "review":
        return this.executeReview(gate.reviewer_prompt);
      case "accept":
        return this.executeAccept(gate.acceptor_prompt);
    }
  }

  /**
   * Execute test commands and check exit codes.
   */
  private async executeTest(
    commands: string[],
    workDir: string,
  ): Promise<QualityGateResult> {
    if (commands.length === 0) {
      return {
        passed: true,
        gate_type: "test",
        message: "No test commands specified",
      };
    }

    const output: string[] = [];
    for (const cmd of commands) {
      try {
        const result = execSync(cmd, {
          cwd: workDir,
          encoding: "utf-8",
          timeout: 300000, // 5 minutes
          stdio: ["pipe", "pipe", "pipe"],
        });
        output.push(`[${cmd}] passed`);
      } catch (error) {
        const err = error as { status?: number; stderr?: string; message?: string };
        return {
          passed: false,
          gate_type: "test",
          message: `Command failed: ${cmd}\nExit code: ${err.status ?? "unknown"}\nError: ${err.stderr ?? err.message ?? "unknown"}`,
        };
      }
    }

    return {
      passed: true,
      gate_type: "test",
      message: output.join("\n"),
    };
  }

  /**
   * Execute self-evaluation against criteria.
   * Placeholder implementation - in production would call LLM.
   */
  private async executeSelfEval(
    criteria: string,
  ): Promise<QualityGateResult> {
    // Placeholder: In production, this would call the LLM to evaluate
    // the task output against the criteria
    return {
      passed: true,
      gate_type: "self_eval",
      message: `Self-evaluation criteria: ${criteria}`,
    };
  }

  /**
   * Execute review gate (async).
   * Returns pending state for async review by reviewer LLM.
   */
  private async executeReview(
    reviewerPrompt: string,
  ): Promise<QualityGateResult> {
    return {
      passed: true,
      gate_type: "review",
      message: `Review pending: ${reviewerPrompt}`,
      requires_async: true,
    };
  }

  /**
   * Execute accept gate (async).
   * Returns pending state for async acceptance by acceptor LLM.
   */
  private async executeAccept(
    acceptorPrompt: string,
  ): Promise<QualityGateResult> {
    return {
      passed: true,
      gate_type: "accept",
      message: `Accept pending: ${acceptorPrompt}`,
      requires_async: true,
    };
  }
}
