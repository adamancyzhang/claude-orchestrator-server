import { describe, it, expect } from "vitest";
import { extractJson } from "../../../src/utils/json.js";

describe("extractJson", () => {
  it("strips ```json fences", () => {
    const out = extractJson('```json\n{"a":1}\n```');
    expect(out).toBe('{"a":1}');
  });

  it("strips unlabeled triple-backtick fences", () => {
    const out = extractJson("```\n{\"a\":1}\n```");
    expect(out).toBe('{"a":1}');
  });

  it("extracts an object embedded in prose", () => {
    const out = extractJson('Here is the result: {"x": 2} done.');
    expect(out).toBe('{"x": 2}');
  });

  it("extracts an array when one is present", () => {
    const out = extractJson('result = [1, 2, 3]');
    expect(out).toBe('[1, 2, 3]');
  });

  it("returns trimmed content when no JSON shape found", () => {
    expect(extractJson("just words\n")).toBe("just words");
  });
});
