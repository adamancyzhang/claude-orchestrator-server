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
    it("loads template files that exist", async () => {
      fs.writeFileSync(path.join(tmpDir, "worker-plan.md"), "# Plan Template\n\nPlan {{task_title}}");
      fs.writeFileSync(path.join(tmpDir, "worker-build.md"), "# Build Template");

      await engine.loadAll();

      expect(engine.get("plan")).toBe("# Plan Template\n\nPlan {{task_title}}");
      expect(engine.get("build")).toBe("# Build Template");
    });

    it("uses fallback for missing template files", async () => {
      // verify, review, accept, decompose are not written — should get fallback
      await engine.loadAll();
      const fb = engine.get("verify");
      expect(fb).toBeDefined();
      expect(fb).toContain("You are a Worker");
      expect(fb).toContain("{{content}}");
    });
  });

  describe("get", () => {
    it("returns loaded template by link name", async () => {
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

    it("returns template unchanged when no placeholders", () => {
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
