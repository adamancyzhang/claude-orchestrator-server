import { describe, expect, it } from "vitest";
import { extractJson } from "../src/json.js";

describe("extractJson", () => {
  it("extracts a JSON object from plain text", () => {
    expect(extractJson('Here is {"a": 1} in text')).toBe('{"a": 1}');
  });

  it("extracts a JSON array from plain text", () => {
    expect(extractJson("Result: [1, 2, 3]")).toBe("[1, 2, 3]");
  });

  it("strips markdown code fences and extracts JSON", () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(extractJson(input)).toBe('{"key": "value"}');
  });

  it("strips plain code fences and extracts JSON", () => {
    const input = '```\n{"key": "value"}\n```';
    expect(extractJson(input)).toBe('{"key": "value"}');
  });

  it("returns the first valid JSON when multiple candidates exist", () => {
    const input = 'First: {"a": 1} then some text then {"b": 2}';
    expect(extractJson(input)).toBe('{"a": 1}');
  });

  it("skips invalid JSON candidates and returns the first valid one", () => {
    const input = 'Not json: {broken} then valid: {"ok": true}';
    expect(extractJson(input)).toBe('{"ok": true}');
  });

  it("handles nested JSON objects", () => {
    const input = 'nested: {"outer": {"inner": 42}} done';
    expect(extractJson(input)).toBe('{"outer": {"inner": 42}}');
  });

  it("handles nested arrays", () => {
    const input = "nested: [[1, 2], [3, 4]] done";
    expect(extractJson(input)).toBe("[[1, 2], [3, 4]]");
  });

  it("returns cleaned input when no valid JSON found", () => {
    expect(extractJson("no json here")).toBe("no json here");
  });

  it("handles empty input", () => {
    expect(extractJson("")).toBe("");
  });

  it("handles input with only whitespace", () => {
    expect(extractJson("   ")).toBe("");
  });

  it("extracts JSON from text with surrounding prose and fences", () => {
    const input = `Here is the result:

\`\`\`json
{"decision": "activate_next", "reason": "looks good"}
\`\`\`

That should work.`;
    expect(extractJson(input)).toBe(
      '{"decision": "activate_next", "reason": "looks good"}',
    );
  });

  it("handles text with explanation before and JSON after", () => {
    const input = `The analysis shows:
{"result": "pass", "score": 95}`;
    expect(extractJson(input)).toBe('{"result": "pass", "score": 95}');
  });

  it("returns pure JSON when input is valid JSON with no wrapping", () => {
    const input = '{"key": "value", "count": 42}';
    expect(extractJson(input)).toBe('{"key": "value", "count": 42}');
  });

  it("returns pure JSON array when input is valid JSON array", () => {
    const input = '[{"id": 1}, {"id": 2}]';
    expect(extractJson(input)).toBe('[{"id": 1}, {"id": 2}]');
  });

  it("handles markdown headers wrapping JSON", () => {
    const input = `## Result

{"task_list": [{"id": 1}], "status": "ok"}`;
    expect(extractJson(input)).toBe('{"task_list": [{"id": 1}], "status": "ok"}');
  });

  it("handles markdown with bold text and JSON", () => {
    const input = `**Here is the output:**

\`\`\`json
{"decision": "approve", "confidence": 0.95}
\`\`\`

*Note: this is final.*`;
    expect(extractJson(input)).toBe('{"decision": "approve", "confidence": 0.95}');
  });

  it("handles multiple markdown headers before JSON", () => {
    const input = `# Analysis

## Step 1

## Step 2

{"result": "done", "steps": 2}`;
    expect(extractJson(input)).toBe('{"result": "done", "steps": 2}');
  });

  it("handles text with horizontal rules and JSON", () => {
    const input = `---

{"action": "continue"}

---`;
    expect(extractJson(input)).toBe('{"action": "continue"}');
  });

  it("handles model response with preamble and code fence", () => {
    const input = `I'll analyze the request and provide the decomposed tasks.

\`\`\`json
{
  "task_list": [
    {"task_id": "1", "role": "planner", "description": "analyze"}
  ]
}
\`\`\`

Here are the decomposed tasks.`;
    expect(extractJson(input)).toContain('"task_list"');
  });

  it("handles empty string", () => {
    expect(extractJson("")).toBe("");
  });
});
