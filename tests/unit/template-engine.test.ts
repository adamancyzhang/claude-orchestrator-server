import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TemplateEngine } from "../../src/executor/template.js";

describe("TemplateEngine", () => {
  let tmpDir: string;
  let engine: TemplateEngine;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "template-test-"));
    engine = new TemplateEngine(tmpDir);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadAll", () => {
    it("loads template files that exist and throws for missing ones", async () => {
      fs.writeFileSync(path.join(tmpDir, "worker-plan.md"), "# Plan Template\n\nPlan {{task_title}}");
      fs.writeFileSync(path.join(tmpDir, "worker-build.md"), "# Build Template");
      // verify, review, accept, decompose are missing — should throw
      await expect(engine.loadAll()).rejects.toThrow("not found");
    });

    it("falls back to builtinDir when workspace template missing", async () => {
      const builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-test-"));
      const links = ["plan", "build", "verify", "review", "accept", "decompose"];
      for (const link of links) {
        fs.writeFileSync(path.join(builtinDir, `worker-${link}.md`), `# Builtin ${link}\n\n{{content}}`);
      }
      const fallbackEngine = new TemplateEngine(tmpDir, builtinDir);
      await fallbackEngine.loadAll();
      expect(fallbackEngine.get("verify")).toBe("# Builtin verify\n\n{{content}}");
      fs.rmSync(builtinDir, { recursive: true, force: true });
    });
  });

  describe("get", () => {
    it("returns loaded template by link name", async () => {
      const links = ["plan", "build", "verify", "review", "accept", "decompose"];
      for (const link of links) {
        fs.writeFileSync(path.join(tmpDir, `worker-${link}.md`), `# ${link}`);
      }
      fs.writeFileSync(path.join(tmpDir, "worker-review.md"), "Review content");
      await engine.loadAll();
      expect(engine.get("review")).toBe("Review content");
    });

    it("returns undefined for unloaded link", () => {
      expect(engine.get("nonexistent")).toBeUndefined();
    });
  });

  describe("render", () => {
    it("substitutes {{key}} placeholders with values", () => {
      const result = engine.render("Hello {{name}}, your task is {{task_title}}.", {
        name: "Alice",
        task_title: "Build the thing",
      });
      expect(result).toBe("Hello Alice, your task is Build the thing.");
    });

    it("replaces multiple occurrences of the same key", () => {
      const result = engine.render("{{x}} {{x}} {{x}}", { x: "y" });
      expect(result).toBe("y y y");
    });

    it("leaves unmatched placeholders as-is", () => {
      const result = engine.render("Hello {{name}}, {{missing}}", { name: "Bob" });
      expect(result).toBe("Hello Bob, {{missing}}");
    });

    it("returns unchanged when no placeholders", () => {
      const result = engine.render("No placeholders here", {});
      expect(result).toBe("No placeholders here");
    });
  });

  describe("loadFile", () => {
    it("loads a specific file from agents directory", async () => {
      fs.writeFileSync(path.join(tmpDir, "worker-evaluate.md"), "# Eval Template");
      const content = await engine.loadFile("worker-evaluate.md");
      expect(content).toBe("# Eval Template");
    });

    it("throws when file not found", async () => {
      await expect(engine.loadFile("nonexistent.md")).rejects.toThrow("not found");
    });
  });
});
