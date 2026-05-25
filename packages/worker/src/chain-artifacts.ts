import * as fs from "node:fs";
import {
  asTaskId,
  cachePaths,
  type ChainId,
  type TaskLink,
  type UpstreamCommits,
} from "@co/contracts";

export const LINK_TO_LOCAL_PREFIX: Record<TaskLink, string> = {
  plan: "plan",
  execute: "execute",
  verify: "verify",
  review: "review",
  accept: "accept",
  explore: "explore",
};

/**
 * Pick the immediate predecessor link's commit hash for pre-task
 * rebase. We rebase onto the *immediate* predecessor (not all
 * upstream links) because each link rebases onto its predecessor in
 * turn, so the predecessor's HEAD already contains the full upstream
 * history. Returns null when there is no upstream commit to rebase
 * onto (planner, first-link retries, decompose tasks, or upstream
 * link did not produce a worktree commit).
 */
export function pickImmediatePredecessor(
  link: TaskLink,
  upstream: UpstreamCommits | undefined,
): string | null {
  if (!upstream) return null;
  // Predecessor order is fixed by chain definition. Walk back from
  // the current link and return the first non-empty hash. Tolerant
  // to gaps (e.g. accept gets a chain where plan committed but
  // execute/verify/review had no worktree commit — accept still
  // rebases onto plan).
  // `accept` is added to the upstream chain because the
  // explore link rebases on top of accept's commit. The list omits
  // explore itself because no link follows it.
  type UpstreamKey = "plan" | "execute" | "verify" | "review" | "accept";
  const order: UpstreamKey[] = [
    "plan",
    "execute",
    "verify",
    "review",
    "accept",
  ];
  if (link === "plan") return null;
  // For "explore": walk the full upstream list back-to-front (accept
  // → review → verify → execute → plan). Other links read their own
  // index minus one as the start of the walk.
  const startIdx =
    link === "explore"
      ? order.length - 1
      : order.indexOf(link as UpstreamKey) - 1;
  for (let i = startIdx; i >= 0; i--) {
    const h = upstream[order[i]];
    if (h) return h;
  }
  return null;
}

export interface ChainArtifactPaths {
  plan: string;
  execute: string;
  verify: string;
  review: string;
  accept: string;
}

/**
 * Resolve upstream artifact paths for the current link by reading the
 * chain manifest. Each upstream link's accepted task_id maps to
 * `tasks/<task_id>/result.md`. Returns 5 empty strings when no chain_id
 * is set (ad-hoc / decompose flows), when link is null or "decompose",
 * or when the manifest file cannot be read / parsed — template rendering
 * remains stable. Output truncation matches the link-position contract:
 *   plan    → empty
 *   execute → only plan
 *   verify  → plan + execute
 *   review  → plan + execute + verify
 *   accept  → plan + execute + verify + review
 *   explore → all 5
 */
export async function collectChainArtifacts(
  cache_paths: cachePaths.CachePathOptions,
  chain_id: ChainId | null | undefined,
  link: TaskLink | "decompose" | null,
): Promise<ChainArtifactPaths> {
  const empty: ChainArtifactPaths = {
    plan: "",
    execute: "",
    verify: "",
    review: "",
    accept: "",
  };
  if (!chain_id || !link || link === "decompose") return empty;

  let manifest: { link_tasks?: Record<string, string | null> } | null = null;
  try {
    const manifestPath = cachePaths.chainManifestPath(cache_paths, chain_id);
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf-8"));
  } catch {
    return empty;
  }

  const linkTasks = manifest?.link_tasks ?? {};
  const lookup = (k: TaskLink): string => {
    const tid = linkTasks[k];
    if (!tid) return "";
    return cachePaths.taskResultPath(cache_paths, asTaskId(tid));
  };
  const plan = lookup("plan");
  const execute = lookup("execute");
  const verify = lookup("verify");
  const review = lookup("review");
  const accept = lookup("accept");
  switch (link as TaskLink) {
    case "plan":
      return empty;
    case "execute":
      return { plan, execute: "", verify: "", review: "", accept: "" };
    case "verify":
      return { plan, execute, verify: "", review: "", accept: "" };
    case "review":
      return { plan, execute, verify, review: "", accept: "" };
    case "accept":
      return { plan, execute, verify, review, accept: "" };
    // explore reads every upstream link's result.md so
    // the Explorer can decide spawn vs close with full context.
    case "explore":
      return { plan, execute, verify, review, accept };
  }
}
