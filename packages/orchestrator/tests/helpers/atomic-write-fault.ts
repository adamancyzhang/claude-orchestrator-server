// Test helper: monkey-patches `fs.promises.writeFile` to throw `EIO`
// exactly N invocations after install. Used by the eval 02 manifest-
// race sub-test (§9 item 9) to inject the crash window the atomic
// `write-to-tmp + rename` strategy is designed to survive.
//
// Restore via the returned `release()` — always call from afterEach to
// avoid bleeding into other tests.

import * as fs from "node:fs";

export interface AtomicWriteFault {
  /** Number of `writeFile` calls observed since installation. */
  call_count(): number;
  /** Whether the fault has fired yet. */
  fired(): boolean;
  /** Restore the original `fs.promises.writeFile`. */
  release(): void;
}

export interface InstallOptions {
  /** Fire EIO on the Nth call (1-indexed). Default 1. */
  fail_at_call: number;
  /**
   * Only fire when the target path matches this predicate. Lets the test
   * narrow the fault to e.g. `manifest.json` while leaving the
   * `.tmp-*` write untouched (so we can observe the rename-before-replace
   * invariant of `writeManifestAtomic`).
   */
  match_path?: (p: string) => boolean;
  /** EIO message — default `simulated mid-write EIO`. */
  message?: string;
}

export function installWriteFault(opts: InstallOptions): AtomicWriteFault {
  let calls = 0;
  let fired = false;
  const original = fs.promises.writeFile;
  const match = opts.match_path ?? (() => true);
  const message = opts.message ?? "simulated mid-write EIO";

  const patched = async function (
    file: Parameters<typeof fs.promises.writeFile>[0],
    data: Parameters<typeof fs.promises.writeFile>[1],
    options?: Parameters<typeof fs.promises.writeFile>[2],
  ): Promise<void> {
    calls += 1;
    const fileStr = typeof file === "string" ? file : file.toString();
    if (calls >= opts.fail_at_call && match(fileStr)) {
      fired = true;
      const err = new Error(message) as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    }
    return original(file, data, options);
  } as typeof fs.promises.writeFile;

  // `fs.promises` is a frozen object on some Node versions but the
  // property descriptors stay writable; assign through it.
  Object.defineProperty(fs.promises, "writeFile", {
    configurable: true,
    writable: true,
    value: patched,
  });

  return {
    call_count: () => calls,
    fired: () => fired,
    release() {
      Object.defineProperty(fs.promises, "writeFile", {
        configurable: true,
        writable: true,
        value: original,
      });
    },
  };
}
