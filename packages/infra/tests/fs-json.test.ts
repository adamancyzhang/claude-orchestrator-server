// CORE-RETENTION
// Locks in: readJson returns null ONLY for ENOENT; any other read or parse
// failure must propagate so callers can distinguish "file is intentionally
// absent" from "file is broken or unreadable." writeJsonAtomic round-trips
// through readJson.
// Critical because: config-loader.ts uses `readJson(path) ?? {}` across five
// merge layers — an absent layer is legal but a malformed layer must crash
// the orchestrator before it runs with partial config. Today's
// `existsSync + readFileSync` pre-check races on deletion and (in restricted
// environments) silently treats unreadable files as "absent."
// Primary sources: packages/infra/src/utils/fs-json.ts

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readJson, writeJsonAtomic, ensureDir } from "../src/utils/fs-json.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-json-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readJson", () => {
  it("returns null when the file does not exist (ENOENT)", () => {
    const result = readJson(path.join(dir, "missing.json"));
    expect(result).toBeNull();
  });

  it("returns the parsed value for a valid JSON file", () => {
    const target = path.join(dir, "ok.json");
    fs.writeFileSync(target, JSON.stringify({ a: 1, b: [2, 3] }));
    expect(readJson(target)).toEqual({ a: 1, b: [2, 3] });
  });

  it("throws SyntaxError on malformed JSON (NOT null)", () => {
    const target = path.join(dir, "bad.json");
    fs.writeFileSync(target, "{not json");
    expect(() => readJson(target)).toThrow();
  });

  it("throws when path is a directory (NOT silently returns null)", () => {
    // existsSync(dir) === true but readFileSync(dir) throws EISDIR. This
    // exercises the same branch as ENOENT-vs-other-error discrimination: any
    // non-ENOENT errno must surface.
    expect(() => readJson(dir)).toThrow();
  });
});

describe("writeJsonAtomic → readJson round-trip", () => {
  it("creates parent directories and round-trips arbitrary JSON", () => {
    const target = path.join(dir, "nested", "deep", "data.json");
    const payload = {
      name: "co",
      version: "0.7.0",
      list: [1, 2, { k: "v" }],
      n: null,
    };
    writeJsonAtomic(target, payload);
    expect(readJson(target)).toEqual(payload);
  });

  it("ensureDir is idempotent", () => {
    const target = path.join(dir, "sub");
    ensureDir(target);
    ensureDir(target);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it("writeJsonAtomic overwrites an existing file atomically (no .tmp leftover)", () => {
    const target = path.join(dir, "overwrite.json");
    writeJsonAtomic(target, { v: 1 });
    writeJsonAtomic(target, { v: 2 });
    expect(readJson(target)).toEqual({ v: 2 });

    // tmp file from the rename dance must not linger.
    const leftovers = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("overwrite.json.") && f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
