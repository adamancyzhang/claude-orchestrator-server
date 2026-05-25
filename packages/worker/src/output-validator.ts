import * as fs from "node:fs";

export const MAX_GENERATION_RETRIES = 3;

export interface GenerationFailure {
  kind: "missing" | "empty" | "exit_code";
  detail: string;
}

/**
 * Classify the result of a single Claude-runner invocation against the
 * worker's success criteria.
 *
 * - exit_code !== 0 → "exit_code" failure with `exit_code=<n>` detail.
 *   Returned BEFORE checking the result file so an early exit doesn't
 *   mask a process crash with a stale-file empty/missing diagnosis.
 * - Non-chain links → exit_code 0 is success; the worker has no result
 *   file contract for ad-hoc messages, so we return null.
 * - Chain links + exit_code 0:
 *     - result file does not exist → "missing"
 *     - result file is 0 bytes → "empty" (size-based, no read needed)
 *     - result file contains only whitespace → "empty" (read + trim)
 *     - non-empty content → null (success)
 *
 * Any fs error during the chain-link checks is interpreted as "missing"
 * — the worker proves the file exists by reading it, and a read error
 * is observably equivalent to the file not being there from the
 * Leader's perspective.
 */
export async function classifyWorkerOutput(args: {
  exit_code: number;
  is_chain_link: boolean;
  result_path: string;
}): Promise<GenerationFailure | null> {
  const { exit_code, is_chain_link, result_path } = args;
  if (exit_code !== 0) {
    return { kind: "exit_code", detail: `exit_code=${exit_code}` };
  }
  if (!is_chain_link) return null;
  try {
    const stat = await fs.promises.stat(result_path);
    if (stat.size === 0) {
      return { kind: "empty", detail: `${result_path} is 0 bytes` };
    }
    const content = await fs.promises.readFile(result_path, "utf-8");
    if (!content.trim()) {
      return {
        kind: "empty",
        detail: `${result_path} contains only whitespace`,
      };
    }
    return null;
  } catch {
    return { kind: "missing", detail: `${result_path} does not exist` };
  }
}
