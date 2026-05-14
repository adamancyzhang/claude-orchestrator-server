module.exports = {
  forbidden: [
    {
      name: "contracts-must-be-pure",
      comment:
        "@co/contracts is Layer 0 — must not import anything except zod " +
        "(pnpm may hoist zod into node_modules/.pnpm/zod@*).",
      from: { path: "^packages/contracts/src/" },
      to: {
        path: "node_modules/",
        pathNot: "/zod/",
      },
      severity: "error",
    },
    {
      name: "infra-only-zk-and-contracts",
      comment: "@co/infra is Layer 1 — must not import upper layers.",
      from: { path: "^packages/infra/src/" },
      to: {
        path: "^packages/(runtime|coordination|leader|worker|orchestrator|cli)/",
      },
      severity: "error",
    },
    {
      name: "runtime-no-zk",
      comment: "@co/runtime must not depend on the ZK client directly.",
      from: { path: "^packages/runtime/src/" },
      to: { path: "node-zookeeper-client" },
      severity: "error",
    },
    {
      name: "coordination-must-not-touch-business",
      from: { path: "^packages/coordination/src/" },
      to: { path: "^packages/(runtime|leader|worker|orchestrator|cli)/" },
      severity: "error",
    },
    {
      name: "leader-worker-isolation",
      from: { path: "^packages/leader/src/" },
      to: { path: "^packages/worker/" },
      severity: "error",
    },
    {
      name: "worker-leader-isolation",
      from: { path: "^packages/worker/src/" },
      to: { path: "^packages/leader/" },
      severity: "error",
    },
    {
      name: "cli-must-not-bypass-orchestrator",
      from: { path: "^packages/cli/src/" },
      to: { path: "^packages/(leader|worker)/" },
      severity: "error",
    },
    // NOTE: cross-package "deep import" enforcement is delegated to each
    // package's package.json `exports` field plus tsconfig project references;
    // a back-referenced regex for "same-package OK, other-package not OK" is
    // rejected by dependency-cruiser as unsafe. The barrel-only contract is
    // enforced at build time when consumers try to import non-exported paths.
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: [
        "node_modules",
        "packages/[^/]+/dist/",
        "packages/[^/]+/tests/",
        "packages/[^/]+/vitest\\.config\\.ts$",
      ],
    },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
