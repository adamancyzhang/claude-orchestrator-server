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

  // ── Real-world decompose model output scenarios ──────────────────
  // These simulate what mimo-v2.5-pro actually returns when asked to
  // decompose a requirement into a ChainDef.

  describe("decompose model output scenarios", () => {
    // Scenario 1: Ideal — model follows instructions, returns pure JSON
    it("Scenario 1: pure JSON (ideal model behavior)", () => {
      const input = `{
  "chain_id": "chain-1",
  "chain_title": "Fix the login bug",
  "task_list": [
    {
      "task_id": "0",
      "title": "Investigate the bug",
      "system_prompt": "## 背景\\n用户报告登录失败",
      "description": "Investigate the login failure",
      "criteria": "root cause identified",
      "quality_gate": { "type": "self_eval", "criteria": "analysis complete" },
      "priority": 1,
      "depends_on": []
    }
  ]
}`;
      const result = extractJson(input);
      const parsed = JSON.parse(result);
      expect(parsed.chain_id).toBe("chain-1");
      expect(parsed.task_list).toHaveLength(1);
    });

    // Scenario 2: Model wraps in markdown code fences (very common)
    it("Scenario 2: markdown code fence wrapping", () => {
      const input = `\`\`\`json
{
  "chain_id": "chain-2",
  "chain_title": "Add dark mode",
  "task_list": [
    {
      "task_id": "0",
      "title": "Implement dark mode",
      "system_prompt": "## 背景\\n用户想要暗色模式",
      "description": "Add dark mode support",
      "criteria": "toggle works",
      "quality_gate": { "type": "test", "criteria": "all tests pass", "commands": ["pnpm test"] },
      "priority": 1,
      "depends_on": []
    }
  ]
}
\`\`\``;
      const result = extractJson(input);
      const parsed = JSON.parse(result);
      expect(parsed.chain_id).toBe("chain-2");
      expect(parsed.task_list).toHaveLength(1);
    });

    // Scenario 3: Model adds prose explanation before JSON
    it("Scenario 3: prose before JSON", () => {
      const input = `I'll analyze the requirement and break it down into tasks.

Here is the task decomposition:

{
  "chain_id": "chain-3",
  "chain_title": "Refactor auth module",
  "task_list": [
    {
      "task_id": "0",
      "title": "Plan the refactoring",
      "system_prompt": "## 背景\\n认证模块需要重构",
      "description": "Create a refactoring plan",
      "criteria": "plan documented",
      "quality_gate": { "type": "self_eval", "criteria": "plan is complete" },
      "priority": 1,
      "depends_on": []
    }
  ]
}`;
      const result = extractJson(input);
      const parsed = JSON.parse(result);
      expect(parsed.chain_id).toBe("chain-3");
    });

    // Scenario 4: Model adds prose + code fence (most common failure case)
    it("Scenario 4: prose + code fence (common failure case)", () => {
      const input = `I'll break down the requirement into tasks for the chain.

\`\`\`json
{
  "chain_id": "chain-4",
  "chain_title": "Add unit tests",
  "task_list": [
    {
      "task_id": "0",
      "title": "Write tests",
      "system_prompt": "## 背景\\n需要补充单元测试",
      "description": "Write unit tests for the API",
      "criteria": "coverage > 80%",
      "quality_gate": { "type": "test", "criteria": "tests pass", "commands": ["pnpm test"] },
      "priority": 1,
      "depends_on": []
    }
  ]
}
\`\`\`

These tasks should cover the requirement.`;
      const result = extractJson(input);
      const parsed = JSON.parse(result);
      expect(parsed.chain_id).toBe("chain-4");
    });

    // Scenario 5: Model adds markdown headers before JSON
    it("Scenario 5: markdown headers before JSON", () => {
      const input = `## Task Decomposition

### Analysis

The requirement needs 2 tasks.

### Chain Definition

{
  "chain_id": "chain-5",
  "chain_title": "Update documentation",
  "task_list": [
    {
      "task_id": "0",
      "title": "Update README",
      "system_prompt": "## 背景\\nREADME 需要更新",
      "description": "Update the README file",
      "criteria": "README is accurate",
      "quality_gate": { "type": "review", "criteria": "docs are clear", "reviewer_prompt": "check accuracy" },
      "priority": 1,
      "depends_on": []
    }
  ]
}`;
      const result = extractJson(input);
      const parsed = JSON.parse(result);
      expect(parsed.chain_id).toBe("chain-5");
    });

    // Scenario 6: Model uses `tasks` array instead of `task_list` (non-compliance)
    it("Scenario 6: model uses 'tasks' array instead of 'task_list'", () => {
      const input = `{
  "chain_id": "chain-6",
  "chain_title": "Fix bug",
  "tasks": [
    {
      "task_id": "0",
      "title": "Fix it",
      "system_prompt": "## 背景\\n修复 bug",
      "description": "Fix the bug",
      "criteria": "bug is fixed",
      "quality_gate": { "type": "test", "criteria": "tests pass", "commands": ["pnpm test"] },
      "priority": 1,
      "depends_on": []
    }
  ]
}`;
      const result = extractJson(input);
      const parsed = JSON.parse(result);
      // extractJson should extract it; normalizeChainDef handles tasks→task_list
      expect(parsed.chain_id).toBe("chain-6");
      expect(parsed.tasks).toHaveLength(1);
    });

    // Scenario 7: Model returns very long system_prompt with special chars
    it("Scenario 7: long system_prompt with special characters", () => {
      const input = `\`\`\`json
{
  "chain_id": "chain-7",
  "chain_title": "Complex task",
  "task_list": [
    {
      "task_id": "0",
      "title": "Do something complex",
      "system_prompt": "## 背景\\n这是一个复杂的任务，包含特殊字符：中文、引号\\"test\\"、换行\\n、制表符\\t、反斜杠\\\\、emoji 🎉、HTML <div>、SQL 'SELECT * FROM users'",
      "description": "Complex task with special chars",
      "criteria": "all handled correctly",
      "quality_gate": { "type": "self_eval", "criteria": "done" },
      "priority": 1,
      "depends_on": []
    }
  ]
}
\`\`\``;
      const result = extractJson(input);
      const parsed = JSON.parse(result);
      expect(parsed.chain_id).toBe("chain-7");
      expect(parsed.task_list[0].system_prompt).toContain("中文");
      expect(parsed.task_list[0].system_prompt).toContain("🎉");
    });

    // Scenario 8: Model returns multiple JSON blocks (ambiguity)
    it("Scenario 8: multiple JSON blocks — returns first valid one", () => {
      const input = `Here's an example of the format:
{"example": true}

And here's the actual result:
{
  "chain_id": "chain-8",
  "chain_title": "Real task",
  "task_list": []
}`;
      const result = extractJson(input);
      const parsed = JSON.parse(result);
      // Should return the first valid JSON candidate
      expect(parsed.example).toBe(true);
    });

    // Scenario 9: Model returns JSON with trailing comma (invalid JSON)
    it("Scenario 9: trailing comma — extractJson returns raw, parse fails", () => {
      const input = `{
  "chain_id": "chain-9",
  "task_list": [],
}`;
      const result = extractJson(input);
      // extractJson returns it as-is since it can't parse
      expect(result).toContain("chain_id");
      // But JSON.parse will fail — this is the actual failure mode
      expect(() => JSON.parse(result)).toThrow();
    });

    // Scenario 10: Model returns JSON with comments (invalid JSON)
    it("Scenario 10: JSON with comments — extractJson returns raw, parse fails", () => {
      const input = `{
  // This is the chain
  "chain_id": "chain-10",
  "task_list": []
}`;
      const result = extractJson(input);
      expect(result).toContain("chain_id");
      expect(() => JSON.parse(result)).toThrow();
    });
  });
});
