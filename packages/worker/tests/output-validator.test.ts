// CORE-RETENTION
// Locks in: classifyWorkerOutput's decision matrix for a single
// Claude-runner attempt:
//   exit_code !== 0          → { kind: "exit_code" } (returned first)
//   !is_chain_link & rc=0    → null (no result-file contract)
//   chain link, file absent  → { kind: "missing" }
//   chain link, size=0       → { kind: "empty" } (size check, no read)
//   chain link, whitespace   → { kind: "empty" } (read + trim)
//   chain link, real content → null (success)
//   fs error on stat/read    → "missing" (observably equivalent to absent)
// Also pins MAX_GENERATION_RETRIES = 3 so the chain-link retry budget
// cannot be silently raised or lowered without an explicit test
// update.
// Critical because: this classifier drives the worker's retry loop
// and the eventual forced-feedback decision. A regression that flips
// "empty" to "success" promotes broken work to activate_next and
// breaks chain integrity; a regression that flips "missing" to
// "exit_code" hides the actual root cause from the retry hint shown
// to Claude on the next attempt.
// Primary sources: packages/worker/src/output-validator.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyWorkerOutput,
  MAX_GENERATION_RETRIES,
} from "../src/output-validator.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "co-out-val-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("MAX_GENERATION_RETRIES", () => {
  it("is pinned to 3 (chain-link retry budget)", () => {
    expect(MAX_GENERATION_RETRIES).toBe(3);
  });
});

describe("classifyWorkerOutput — exit code", () => {
  it("non-zero exit code returns exit_code failure (before checking the result file)", async () => {
    // Note: we intentionally pass a result_path that DOESN'T exist to
    // verify exit_code wins over the missing-file diagnosis.
    const got = await classifyWorkerOutput({
      exit_code: 1,
      is_chain_link: true,
      result_path: path.join(tmpRoot, "no-such-file.md"),
    });
    expect(got).toEqual({ kind: "exit_code", detail: "exit_code=1" });
  });

  it("negative exit code is also treated as failure", async () => {
    const got = await classifyWorkerOutput({
      exit_code: -1,
      is_chain_link: true,
      result_path: path.join(tmpRoot, "ignored.md"),
    });
    expect(got?.kind).toBe("exit_code");
    expect(got?.detail).toContain("exit_code=-1");
  });
});

describe("classifyWorkerOutput — non-chain-link path", () => {
  it("returns null when is_chain_link=false and exit_code=0 (no result-file contract)", async () => {
    const got = await classifyWorkerOutput({
      exit_code: 0,
      is_chain_link: false,
      result_path: path.join(tmpRoot, "irrelevant.md"),
    });
    expect(got).toBeNull();
  });
});

describe("classifyWorkerOutput — chain-link result file", () => {
  it("returns 'missing' when the result file does not exist", async () => {
    const got = await classifyWorkerOutput({
      exit_code: 0,
      is_chain_link: true,
      result_path: path.join(tmpRoot, "absent.md"),
    });
    expect(got?.kind).toBe("missing");
    expect(got?.detail).toContain("does not exist");
  });

  it("returns 'empty' for a 0-byte file", async () => {
    const p = path.join(tmpRoot, "zero.md");
    fs.writeFileSync(p, "", "utf-8");
    const got = await classifyWorkerOutput({
      exit_code: 0,
      is_chain_link: true,
      result_path: p,
    });
    expect(got?.kind).toBe("empty");
    expect(got?.detail).toContain("0 bytes");
  });

  it("returns 'empty' for a file containing only whitespace", async () => {
    const p = path.join(tmpRoot, "whitespace.md");
    fs.writeFileSync(p, "   \n\t  \n  ", "utf-8");
    const got = await classifyWorkerOutput({
      exit_code: 0,
      is_chain_link: true,
      result_path: p,
    });
    expect(got?.kind).toBe("empty");
    expect(got?.detail).toContain("only whitespace");
  });

  it("returns null (success) for a non-empty result file", async () => {
    const p = path.join(tmpRoot, "good.md");
    fs.writeFileSync(p, "# Plan\n\n- step 1\n", "utf-8");
    const got = await classifyWorkerOutput({
      exit_code: 0,
      is_chain_link: true,
      result_path: p,
    });
    expect(got).toBeNull();
  });

  it("returns 'missing' when the result_path resolves to a directory (fs error)", async () => {
    // Stat on a path that exists but is a directory should not crash —
    // the catch block treats it as missing.
    const p = path.join(tmpRoot, "is-a-dir");
    fs.mkdirSync(p);
    const got = await classifyWorkerOutput({
      exit_code: 0,
      is_chain_link: true,
      result_path: p,
    });
    // stat() succeeds with size=4096 on most filesystems for directories;
    // the read then triggers EISDIR which falls into the catch block.
    // The classification is "missing" because that's the observable
    // signal to the worker: "I cannot read your result file."
    expect(got?.kind).toBe("missing");
  });
});
