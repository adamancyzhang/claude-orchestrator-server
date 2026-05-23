// Filesystem snapshot helper for e2e tests. Produces a deterministic,
// JSON-serializable view of a directory tree for comparison with the
// expected layout documented in `docs/evals/01-startup-worker-6.md §3.8`.

import * as fs from "node:fs";
import * as path from "node:path";

export interface FsTreeNode {
  name: string;
  type: "dir" | "file" | "symlink";
  children?: FsTreeNode[];
  size?: number;
}

export interface DumpDirOptions {
  /** Substring patterns to skip; matched against the *name* of each entry. */
  ignore?: readonly string[];
  /** Hide file sizes — useful for snapshotting structure only. */
  exclude_sizes?: boolean;
}

const DEFAULT_IGNORE = [".git"];

export function dumpDir(root: string, opts: DumpDirOptions = {}): FsTreeNode {
  const ignore = opts.ignore ?? DEFAULT_IGNORE;
  return walk(root, path.basename(root), ignore, opts.exclude_sizes ?? false);
}

function walk(
  full: string,
  name: string,
  ignore: readonly string[],
  exclude_sizes: boolean,
): FsTreeNode {
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) {
    return { name, type: "symlink" };
  }
  if (stat.isFile()) {
    const node: FsTreeNode = { name, type: "file" };
    if (!exclude_sizes) node.size = stat.size;
    return node;
  }
  const entries = fs
    .readdirSync(full)
    .filter((e) => !ignore.some((p) => e === p))
    .sort();
  const children: FsTreeNode[] = [];
  for (const e of entries) {
    children.push(walk(path.join(full, e), e, ignore, exclude_sizes));
  }
  return { name, type: "dir", children };
}

/**
 * Find a node by relative path (e.g. ".claude-orchestrator/worktree/Tom")
 * starting from the dumped tree. Returns undefined if any segment is missing.
 */
export function findNode(
  tree: FsTreeNode,
  relPath: string,
): FsTreeNode | undefined {
  if (relPath === "") return tree;
  const parts = relPath.split("/").filter((s) => s.length > 0);
  let cur: FsTreeNode | undefined = tree;
  for (const part of parts) {
    if (!cur || cur.type !== "dir" || !cur.children) return undefined;
    cur = cur.children.find((c) => c.name === part);
  }
  return cur;
}

/** List immediate child names of a directory node, sorted. */
export function childNames(node: FsTreeNode | undefined): string[] {
  if (!node || node.type !== "dir" || !node.children) return [];
  return node.children.map((c) => c.name).sort();
}
