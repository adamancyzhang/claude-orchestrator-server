#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WHITELIST = {
  "@co/contracts": { deps: [], peerDeps: ["zod"] },
  "@co/infra": { deps: ["node-zookeeper-client", "zod"], peerDeps: ["@co/contracts"] },
  "@co/runtime": { deps: ["zod"], peerDeps: ["@co/contracts", "@co/infra"] },
  "@co/coordination": { deps: ["zod"], peerDeps: ["@co/contracts", "@co/infra"] },
  "@co/leader": { deps: ["zod"], peerDeps: ["@co/contracts", "@co/runtime", "@co/coordination"] },
  "@co/worker": { deps: ["zod"], peerDeps: ["@co/contracts", "@co/runtime", "@co/coordination"] },
  "@co/orchestrator": {
    deps: ["zod"],
    peerDeps: [
      "@co/contracts",
      "@co/infra",
      "@co/runtime",
      "@co/coordination",
      "@co/leader",
      "@co/worker",
    ],
  },
  "@co/cli": {
    deps: ["commander", "zod"],
    peerDeps: ["@co/contracts", "@co/infra", "@co/coordination", "@co/orchestrator"],
  },
};

const ROOT = process.cwd();
const PKG_DIR = join(ROOT, "packages");

let errors = 0;
for (const pkgName of readdirSync(PKG_DIR)) {
  const pkgJsonPath = join(PKG_DIR, pkgName, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    continue;
  }
  const rule = WHITELIST[pkg.name];
  if (!rule) {
    console.error(`[check-pkg-deps] Unknown package ${pkg.name}`);
    errors++;
    continue;
  }
  const declaredDeps = Object.keys(pkg.dependencies ?? {});
  const declaredPeers = Object.keys(pkg.peerDependencies ?? {});
  const extraDeps = declaredDeps.filter((d) => !rule.deps.includes(d));
  const extraPeers = declaredPeers.filter((d) => !rule.peerDeps.includes(d));
  if (extraDeps.length || extraPeers.length) {
    console.error(
      `[check-pkg-deps] ${pkg.name}: forbidden deps=${extraDeps.join(",")} peerDeps=${extraPeers.join(",")}`,
    );
    errors++;
  }
}

if (errors) {
  console.error(`[check-pkg-deps] ${errors} violation(s).`);
  process.exit(1);
}
console.log("[check-pkg-deps] OK");
