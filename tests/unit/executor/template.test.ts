import { describe, it, expect } from "vitest";
import { TemplateEngine } from "../../../src/executor/template.js";

describe("TemplateEngine.render", () => {
  const engine = new TemplateEngine("/tmp/agents-does-not-exist");

  it("substitutes simple {{var}} placeholders", () => {
    const out = engine.render("Hello {{name}}", { name: "World" });
    expect(out).toBe("Hello World");
  });

  it("substitutes the same placeholder globally", () => {
    const out = engine.render("{{x}} and {{x}}", { x: "Y" });
    expect(out).toBe("Y and Y");
  });

  it("leaves un-provided placeholders intact", () => {
    const out = engine.render("Hello {{missing}}", {});
    expect(out).toBe("Hello {{missing}}");
  });

  it("inserts special characters literally (no re-templating)", () => {
    const out = engine.render("Path: {{p}}", { p: "/foo/{{nested}}" });
    expect(out).toBe("Path: /foo/{{nested}}");
  });

  it("handles empty template", () => {
    expect(engine.render("", { x: "y" })).toBe("");
  });
});
