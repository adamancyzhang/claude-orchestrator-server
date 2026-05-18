// CORE-RETENTION
// Locks in: TemplateEngine pure {{var}} rendering and TemplateNotFoundError
//   on missing files. Identity injection is explicitly NOT a TemplateEngine
//   concern in v0.5 (it lives in ClaudeRunner.buildIdentityPrompt).
// Core path because: every Worker prompt is composed via render(); a regression
//   here changes every message sent to claude-cli.
// Owner subsystem: runtime.
// Primary source files exercised:
//   - packages/runtime/src/template.ts

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TemplateEngine } from "../../../src/index.js";
import { TemplateNotFoundError } from "@co/contracts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tpl-test-"));
}

describe("TemplateEngine", () => {
  it("substitutes {{vars}} globally", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "x.md"), "Hello {{name}}, role {{role}}.");
    const tpl = new TemplateEngine({ primary_dir: dir });
    expect(tpl.render("x.md", { name: "Tom", role: "executor" })).toBe(
      "Hello Tom, role executor.",
    );
  });

  it("falls back to fallback_dir when primary lacks the file", () => {
    const primary = makeTempDir();
    const fallback = makeTempDir();
    fs.writeFileSync(path.join(fallback, "y.md"), "fallback {{x}}");
    const tpl = new TemplateEngine({
      primary_dir: primary,
      fallback_dir: fallback,
    });
    expect(tpl.render("y.md", { x: "ok" })).toBe("fallback ok");
  });

  it("throws TemplateNotFoundError when neither dir has the file", () => {
    const tpl = new TemplateEngine({ primary_dir: makeTempDir() });
    expect(() => tpl.load("missing.md")).toThrow(TemplateNotFoundError);
  });

  it("has() reports presence without throwing", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "z.md"), "");
    const tpl = new TemplateEngine({ primary_dir: dir });
    expect(tpl.has("z.md")).toBe(true);
    expect(tpl.has("nope.md")).toBe(false);
  });
});
