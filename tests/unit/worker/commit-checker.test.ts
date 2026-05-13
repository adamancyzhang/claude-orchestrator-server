import { describe, it, expect } from "vitest";
import { CommitChecker } from "../../../src/worker/commit-checker.js";

// Access private parseStatus via an unconventional cast — it's the pure unit we want to test.
type PrivateParseStatus = (s: string) => { changed: string[]; untracked: string[] };

function parser(): PrivateParseStatus {
  const c = new CommitChecker("/tmp", {} as never);
  return (c as unknown as { parseStatus: PrivateParseStatus }).parseStatus.bind(c);
}

describe("CommitChecker.parseStatus", () => {
  it("empty output → no changes", () => {
    const out = parser()("");
    expect(out.changed).toEqual([]);
    expect(out.untracked).toEqual([]);
  });

  it("classifies untracked (??), modified (M), and added (A) correctly", () => {
    // Note: parseStatus does statusOutput.trim() first, so leading-space lines
    // get mangled at the head of the buffer. We test with a non-space first
    // line to lock the well-formed-input behavior.
    const output = `M  src/foo.ts\nA  src/bar.ts\n?? src/baz.ts\n`;
    const out = parser()(output);
    expect(out.untracked).toEqual(["src/baz.ts"]);
    expect(out.changed).toEqual([
      "M src/foo.ts",
      "A src/bar.ts",
    ]);
  });

  it("handles rename status 'R '", () => {
    const out = parser()("R  old.ts -> new.ts\n");
    expect(out.changed).toEqual(["R old.ts -> new.ts"]);
  });

  it("ignores empty lines", () => {
    const out = parser()("M  a.ts\n\nM  b.ts\n");
    expect(out.changed).toEqual(["M a.ts", "M b.ts"]);
  });
});
