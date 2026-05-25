// CORE-RETENTION
// Locks in: chain-router decision-legality matrix, ChainDef shape predicate,
// and merge-error formatting + categorization. These four free functions
// drive routing decisions across ChainRouter; they encode the link × decision
// permission table (DD 02 §5.2) and the merge-error taxonomy that distinguishes
// retry-eligible failures from operator-alert failures.
// Critical because: a silent edit (e.g. allowing spawn_chain at accept, or
// re-categorizing GitNetworkError as conflict) would either let the magic
// loop escape its sandbox or convert a network outage into an infinite retry
// storm. The tests defend the matrix directly.
// Primary sources: packages/leader/src/chain-router.ts (lines ~105, 131, 148, 164)

import { describe, expect, it } from "vitest";
import {
  GitNetworkError,
  GitPermissionError,
  MergeConflictError,
  WorktreeLockedError,
  type EvalDecision,
  type TaskLink,
} from "@co/contracts";
import {
  categorizeMergeError,
  formatMergeError,
  isDecisionLegalForLink,
  looksLikeChainDef,
} from "../src/index.js";

// ── isDecisionLegalForLink — exhaustive matrix ────────────────────────

describe("isDecisionLegalForLink (DD 02 §5.2)", () => {
  const LINKS: TaskLink[] = [
    "plan",
    "execute",
    "verify",
    "review",
    "accept",
    "explore",
  ];

  it("spawn_chain is legal ONLY at explore with magic_mode=true", () => {
    for (const link of LINKS) {
      expect(isDecisionLegalForLink("spawn_chain", link, false)).toBe(false);
      expect(isDecisionLegalForLink("spawn_chain", link, true)).toBe(
        link === "explore",
      );
    }
  });

  it("activate_next is illegal at explore (terminal link, no NEXT)", () => {
    expect(isDecisionLegalForLink("activate_next", "explore", false)).toBe(
      false,
    );
    expect(isDecisionLegalForLink("activate_next", "explore", true)).toBe(
      false,
    );
  });

  it("activate_next at accept is legal only with magic_mode=true", () => {
    expect(isDecisionLegalForLink("activate_next", "accept", false)).toBe(
      false,
    );
    expect(isDecisionLegalForLink("activate_next", "accept", true)).toBe(true);
  });

  it("activate_next at plan / execute / verify / review is always legal", () => {
    for (const link of ["plan", "execute", "verify", "review"] as TaskLink[]) {
      expect(isDecisionLegalForLink("activate_next", link, false)).toBe(true);
      expect(isDecisionLegalForLink("activate_next", link, true)).toBe(true);
    }
  });

  it("feedback / reject / close_chain are legal at every link, both modes", () => {
    const decisions: EvalDecision["decision"][] = [
      "feedback",
      "reject",
      "close_chain",
    ];
    for (const decision of decisions) {
      for (const link of LINKS) {
        expect(isDecisionLegalForLink(decision, link, false)).toBe(true);
        expect(isDecisionLegalForLink(decision, link, true)).toBe(true);
      }
    }
  });
});

// ── looksLikeChainDef — JSON shape predicate ─────────────────────────

describe("looksLikeChainDef", () => {
  it("returns true for a JSON blob with chain_id + tasks keys", () => {
    expect(
      looksLikeChainDef(
        JSON.stringify({ chain_id: "c1", tasks: { plan: null } }),
      ),
    ).toBe(true);
  });

  it("returns true when the JSON is wrapped in a fenced ```json``` block", () => {
    const fenced =
      "```json\n" +
      JSON.stringify({ chain_id: "c1", tasks: {} }) +
      "\n```";
    expect(looksLikeChainDef(fenced)).toBe(true);
  });

  it("returns false for JSON that lacks chain_id", () => {
    expect(looksLikeChainDef(JSON.stringify({ tasks: {} }))).toBe(false);
  });

  it("returns false for JSON that lacks tasks", () => {
    expect(looksLikeChainDef(JSON.stringify({ chain_id: "c1" }))).toBe(false);
  });

  it("returns false for non-JSON / malformed content", () => {
    expect(looksLikeChainDef("not json")).toBe(false);
    expect(looksLikeChainDef("")).toBe(false);
    expect(looksLikeChainDef("{not json")).toBe(false);
  });

  it("returns false for primitive JSON values", () => {
    expect(looksLikeChainDef("42")).toBe(false);
    expect(looksLikeChainDef("\"hello\"")).toBe(false);
    expect(looksLikeChainDef("null")).toBe(false);
  });
});

// ── formatMergeError + categorizeMergeError ──────────────────────────

describe("categorizeMergeError", () => {
  it("returns 'conflict' for MergeConflictError", () => {
    expect(
      categorizeMergeError(new MergeConflictError("c", ["x.ts"])),
    ).toBe("conflict");
  });

  it("returns 'worktree_locked' for WorktreeLockedError", () => {
    expect(categorizeMergeError(new WorktreeLockedError("l"))).toBe(
      "worktree_locked",
    );
  });

  it("returns 'permission' for GitPermissionError", () => {
    expect(categorizeMergeError(new GitPermissionError("p"))).toBe(
      "permission",
    );
  });

  it("returns 'network' for GitNetworkError", () => {
    expect(categorizeMergeError(new GitNetworkError("n"))).toBe("network");
  });

  it("returns 'other' for anything else", () => {
    expect(categorizeMergeError(new Error("plain"))).toBe("other");
    expect(categorizeMergeError("string err")).toBe("other");
    expect(categorizeMergeError(null)).toBe("other");
  });
});

describe("formatMergeError", () => {
  it("prefixes 'conflict:' and joins conflict_files", () => {
    const e = new MergeConflictError("merge failed", ["a.ts", "b.ts"]);
    expect(formatMergeError(e)).toBe("conflict: a.ts, b.ts");
  });

  it("falls back to the error message when conflict_files is empty", () => {
    const e = new MergeConflictError("the conflict message", []);
    expect(formatMergeError(e)).toBe("conflict: the conflict message");
  });

  it("prefixes 'worktree_locked:' with stderr or message", () => {
    expect(formatMergeError(new WorktreeLockedError("ctx", "index.lock"))).toBe(
      "worktree_locked: index.lock",
    );
    expect(formatMergeError(new WorktreeLockedError("ctx-only"))).toBe(
      "worktree_locked: ctx-only",
    );
  });

  it("prefixes 'permission:' for GitPermissionError", () => {
    expect(formatMergeError(new GitPermissionError("denied", "EACCES"))).toBe(
      "permission: EACCES",
    );
  });

  it("prefixes 'network:' for GitNetworkError", () => {
    expect(
      formatMergeError(new GitNetworkError("net", "could not resolve")),
    ).toBe("network: could not resolve");
  });

  it("falls back to String(err) for unrecognized errors", () => {
    expect(formatMergeError(new Error("weird"))).toContain("weird");
    expect(formatMergeError("plain string")).toBe("plain string");
  });
});
