// CORE-RETENTION
// Locks in: TemplateEngine's two-tier (primary_dir shadows fallback_dir)
// lookup, the in-memory cache, fail-loud TemplateNotFoundError on miss
// (no silent fallback), `{{key}}` global substitution semantics,
// preservation of unmatched placeholders (so missing variables are
// visible — not masked), and the has()/load() agreement.
// Critical because: TemplateEngine is the only path through which all
// six worker roles obtain their identity-card, responsibilities, task,
// decompose, evaluate, commit-message, and memorize templates. A silent
// fallback ("template missing → empty string") would let workers boot
// with an empty system prompt; a stale cache that fails to reload would
// freeze worker behavior to the first version read; a swallowed
// TemplateNotFoundError would propagate empty bodies into Claude
// prompts and corrupt every downstream decision.
// Primary sources: packages/runtime/src/template.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TemplateNotFoundError } from "@co/contracts";
import { TemplateEngine } from "../src/template.js";

let primaryDir: string;
let fallbackDir: string;

beforeEach(() => {
  primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-tpl-primary-"));
  fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-tpl-fallback-"));
});

afterEach(() => {
  fs.rmSync(primaryDir, { recursive: true, force: true });
  fs.rmSync(fallbackDir, { recursive: true, force: true });
});

function write(dir: string, name: string, body: string): void {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, "utf-8");
}

describe("TemplateEngine.load — two-tier lookup", () => {
  it("reads from primary_dir when the file exists there", () => {
    write(primaryDir, "agents/planner/task.md", "PRIMARY");
    const engine = new TemplateEngine({
      primary_dir: primaryDir,
      fallback_dir: fallbackDir,
    });
    expect(engine.load("agents/planner/task.md")).toBe("PRIMARY");
  });

  it("falls back to fallback_dir when primary does not have the file", () => {
    write(fallbackDir, "agents/planner/task.md", "FALLBACK");
    const engine = new TemplateEngine({
      primary_dir: primaryDir,
      fallback_dir: fallbackDir,
    });
    expect(engine.load("agents/planner/task.md")).toBe("FALLBACK");
  });

  it("primary shadows fallback when both directories have the file", () => {
    write(primaryDir, "agents/planner/task.md", "PRIMARY");
    write(fallbackDir, "agents/planner/task.md", "FALLBACK");
    const engine = new TemplateEngine({
      primary_dir: primaryDir,
      fallback_dir: fallbackDir,
    });
    expect(engine.load("agents/planner/task.md")).toBe("PRIMARY");
  });

  it("throws TemplateNotFoundError when neither directory has the file", () => {
    const engine = new TemplateEngine({
      primary_dir: primaryDir,
      fallback_dir: fallbackDir,
    });
    expect(() => engine.load("agents/missing.md")).toThrow(
      TemplateNotFoundError,
    );
    expect(() => engine.load("agents/missing.md")).toThrow(
      /agents\/missing\.md/,
    );
  });

  it("throws TemplateNotFoundError when fallback_dir is not configured and primary misses", () => {
    const engine = new TemplateEngine({ primary_dir: primaryDir });
    expect(() => engine.load("nope.md")).toThrow(TemplateNotFoundError);
  });
});

describe("TemplateEngine.load — caching", () => {
  it("returns the cached body even after the underlying file is overwritten", () => {
    write(primaryDir, "x.md", "v1");
    const engine = new TemplateEngine({ primary_dir: primaryDir });

    expect(engine.load("x.md")).toBe("v1");
    fs.writeFileSync(path.join(primaryDir, "x.md"), "v2", "utf-8");
    expect(engine.load("x.md")).toBe("v1");
  });
});

describe("TemplateEngine.render", () => {
  it("substitutes {{key}} occurrences globally", () => {
    write(primaryDir, "greet.md", "Hello {{name}}, hello again {{name}}!");
    const engine = new TemplateEngine({ primary_dir: primaryDir });
    expect(engine.render("greet.md", { name: "Tom" })).toBe(
      "Hello Tom, hello again Tom!",
    );
  });

  it("leaves unmatched {{placeholders}} intact (no silent fallback)", () => {
    write(primaryDir, "echo.md", "name={{name}} role={{role}} extra={{missing}}");
    const engine = new TemplateEngine({ primary_dir: primaryDir });
    expect(engine.render("echo.md", { name: "Tom", role: "planner" })).toBe(
      "name=Tom role=planner extra={{missing}}",
    );
  });

  it("substitutes an empty string when explicitly passed empty (NOT a fallback to placeholder)", () => {
    write(primaryDir, "echo.md", "value=[{{value}}]");
    const engine = new TemplateEngine({ primary_dir: primaryDir });
    expect(engine.render("echo.md", { value: "" })).toBe("value=[]");
  });

  it("render propagates TemplateNotFoundError when the template is missing", () => {
    const engine = new TemplateEngine({ primary_dir: primaryDir });
    expect(() => engine.render("absent.md", { x: "y" })).toThrow(
      TemplateNotFoundError,
    );
  });
});

describe("TemplateEngine.has", () => {
  it("returns true when the file exists in primary", () => {
    write(primaryDir, "p.md", "x");
    const engine = new TemplateEngine({
      primary_dir: primaryDir,
      fallback_dir: fallbackDir,
    });
    expect(engine.has("p.md")).toBe(true);
  });

  it("returns true when the file exists only in fallback", () => {
    write(fallbackDir, "f.md", "x");
    const engine = new TemplateEngine({
      primary_dir: primaryDir,
      fallback_dir: fallbackDir,
    });
    expect(engine.has("f.md")).toBe(true);
  });

  it("returns false when neither tier has the file", () => {
    const engine = new TemplateEngine({
      primary_dir: primaryDir,
      fallback_dir: fallbackDir,
    });
    expect(engine.has("nope.md")).toBe(false);
  });

  it("returns false when fallback_dir is not configured and primary misses", () => {
    const engine = new TemplateEngine({ primary_dir: primaryDir });
    expect(engine.has("nope.md")).toBe(false);
  });
});
