// CORE-RETENTION
// Locks in: extractJson string-cleaning semantics — markdown fence stripping
//   and first-object/array extraction. Claude-cli output often wraps JSON in
//   ``` fences; misparsing here cascades into broken EvalDecisions and
//   ChainDefs.
// Core path because: every JSON-bearing message from claude-cli (EvalDecision,
//   ChainDef, MergeDecision) is run through this function before parsing.
// Owner subsystem: infra.
// Primary source files exercised:
//   - packages/infra/src/utils/json.ts

import { describe, expect, it } from "vitest";
import { extractJson } from "../../../src/index.js";

describe("extractJson", () => {
  it("returns raw JSON unchanged", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it("strips ```json fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips plain ``` fences", () => {
    expect(extractJson('```\n[1,2]\n```')).toBe("[1,2]");
  });

  it("extracts the first object from surrounding prose", () => {
    expect(extractJson('blah {"x":2} blah')).toBe('{"x":2}');
  });

  it("handles multiline nested JSON", () => {
    const input = '```json\n{\n  "a": {\n    "b": 1\n  }\n}\n```';
    expect(extractJson(input)).toBe('{\n  "a": {\n    "b": 1\n  }\n}');
  });
});
