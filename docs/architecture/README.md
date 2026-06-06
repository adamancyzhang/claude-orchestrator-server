# Architecture Documentation

System architecture documentation for Claude Orchestrator.

## Documents

| Document | Description |
|----------|-------------|
| [system-overview.md](system-overview.md) | High-level architecture, package layering, core components, and design decisions |
| [component-reference.md](component-reference.md) | Detailed class/interface documentation for all 8 packages |
| [data-flow.md](data-flow.md) | Task lifecycle, message routing, chain management, and pipeline diagrams |
| [deployment.md](deployment.md) | Installation, configuration, running modes, CLI commands, and troubleshooting |

## Quick Reference

### Package Layers (dependency flows downward)

```
Layer 6: @co/cli          (CLI entry point)
Layer 5: @co/orchestrator (startup, process management)
Layer 4a: @co/leader      (TUI, routing, merge validation)
Layer 4b: @co/worker      (pipeline, evaluation, commits)
Layer 3: @co/coordination (TaskQueue, MessageRouter, InstanceRegistry)
Layer 2: @co/runtime      (ClaudeRunner, TemplateEngine, HookEngine)
Layer 1: @co/infra        (Logger, ConfigLoader, ZkClient)
Layer 0: @co/contracts    (IDs, schemas, interfaces, errors)
```

### Core Flow

```
User requirement -> Leader decomposes -> ChainDef -> Tasks created
  -> Workers execute pipeline -> EvalDecision -> Routing decision
  -> Chain close -> Merge validation -> Done
```

### Key Constraint

Layer 4a (leader) and Layer 4b (worker) must never import each other. They communicate only through Layer 3 (coordination) interfaces.
