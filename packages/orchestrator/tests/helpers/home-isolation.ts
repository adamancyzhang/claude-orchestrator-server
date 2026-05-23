// Helper that isolates HOME-related writes during tests so the
// InitChecker doesn't touch the real `~/.claude-orchestrator/` or
// `~/.claude/CLAUDE.md`. Returns paths the caller can inspect.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface IsolatedHome {
  home: string;
  cleanup(): void;
  restore(): void;
}

export function withTempHome(): IsolatedHome {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "co-eval-home-"));
  const original = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  return {
    home,
    cleanup(): void {
      fs.rmSync(home, { recursive: true, force: true });
    },
    restore(): void {
      if (original.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = original.HOME;
      if (original.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = original.USERPROFILE;
    },
  };
}

/**
 * `os.homedir()` is the gate the orchestrator uses (`init-checker.ts` line 36
 * via `expandHomeDir`). On Linux it honors `process.env.HOME`; on
 * Windows it honors `USERPROFILE`. We override both for safety. Tests
 * should still verify by calling `os.homedir()` post-setup.
 */
export function effectiveHome(): string {
  return os.homedir();
}
