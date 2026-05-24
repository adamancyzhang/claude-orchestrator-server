// Test helper: generates a tmpdir of bash scripts (one per
// `HookEventType` in `packages/contracts/src/hooks.ts`) that capture
// every CO_* environment variable to a file. The e2e test reads the
// captured files and asserts the env schema matches what
// `packages/contracts/src/hooks.ts:9-58` documents — exercising the
// §9 item 3 checklist from `docs/evals/02-leader-worker-communication.md`.
//
// The scripts are fire-and-forget: HookEngine (packages/runtime/src/hook-engine.ts)
// spawns them with `sh -c <script>` + `detached + unref` + 5s timeout.
// We make each script self-contained so it never depends on cwd or PATH.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HOOK_EVENT_TYPES, type HookCommand, type HookEventType } from "@co/contracts";

export interface HookCaptureRecord {
  /** Filename in the capture dir, useful for cross-referencing. */
  file: string;
  /** Parsed `KEY=VALUE` lines from the capture. */
  env: Record<string, string>;
  /** Approx fire time (recovered from filename timestamp). */
  fired_at_ns: bigint;
}

export interface HookHarness {
  /** Pass to `ResolvedConfig.hooks` (production-shape). */
  hook_configs: readonly HookCommand[];
  /** All captures for a given event, sorted by fire time. */
  read_captured(event: HookEventType): HookCaptureRecord[];
  /** All captures across all events. */
  read_all(): readonly HookCaptureRecord[];
  /** Total number of files written so far. */
  total_fired(): number;
  /** Recursively remove the tmpdir. */
  cleanup(): void;
}

export function createHookHarness(): HookHarness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "co-eval-hooks-"));
  const captureDir = path.join(tmp, "captures");
  fs.mkdirSync(captureDir, { recursive: true });

  const hook_configs: HookCommand[] = HOOK_EVENT_TYPES.map((event) => {
    // One script per event so we can introspect by event without
    // having to parse a multiplexed log.
    const scriptPath = path.join(tmp, `${event}.sh`);
    // Use process.hrtime.bigint()-style timestamp for ordering, but
    // bash only has `date +%s%N`. Linux supports `%N`; macOS does not —
    // for portability fall back to `date +%s%6N` then strip if needed.
    // The tests run on Linux containers so `%s%N` is fine.
    const script =
      `#!/usr/bin/env bash\n` +
      `set -u\n` +
      `out="${captureDir}/${event}-$(date +%s%N).env"\n` +
      `env | grep '^CO_' > "$out" || true\n` +
      // Some events ship typed scalars (exit_code, duration_seconds) via
      // top-level env (see hook-engine.ts:81-89 flattenEnv). Capture
      // those too if they don't start with CO_.
      `env | grep -E '^(exit_code|duration_seconds)=' >> "$out" || true\n`;
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    return {
      event,
      command: `bash ${scriptPath}`,
      enabled: true,
    };
  });

  function readCaptureFile(file: string): HookCaptureRecord {
    const raw = fs.readFileSync(path.join(captureDir, file), "utf-8");
    const env: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    // filename: <event>-<nanos>.env
    const m = file.match(/-(\d+)\.env$/);
    return {
      file,
      env,
      fired_at_ns: m ? BigInt(m[1]) : 0n,
    };
  }

  return {
    hook_configs,
    read_captured(event) {
      if (!fs.existsSync(captureDir)) return [];
      const prefix = `${event}-`;
      return fs
        .readdirSync(captureDir)
        .filter((f) => f.startsWith(prefix))
        .map(readCaptureFile)
        .sort((a, b) => (a.fired_at_ns < b.fired_at_ns ? -1 : 1));
    },
    read_all() {
      if (!fs.existsSync(captureDir)) return [];
      return fs
        .readdirSync(captureDir)
        .map(readCaptureFile)
        .sort((a, b) => (a.fired_at_ns < b.fired_at_ns ? -1 : 1));
    },
    total_fired() {
      if (!fs.existsSync(captureDir)) return 0;
      return fs.readdirSync(captureDir).length;
    },
    cleanup() {
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}
