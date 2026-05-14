// CORE-RETENTION
// Locks in: Logger.child() namespacing and LogLevel filtering. Every Layer ≥1
//   class receives `ILogger` and derives its namespace via `child(name)`.
// Core path because: namespaces are how log readers attribute failures to
//   subsystems; level filtering is how --debug mode controls verbosity.
// Owner subsystem: infra.
// Primary source files exercised:
//   - packages/infra/src/logger.ts

import { describe, expect, it, vi } from "vitest";
import { Logger } from "../../../src/index.js";

describe("Logger", () => {
  it("emits namespaced lines at or above level", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const logger = new Logger({ namespace: "test", level: "warn" });
      logger.debug("should not appear");
      logger.info("should not appear");
      logger.warn("warn message");
      logger.error("error message");
      expect(log).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[test] warn message"));
      expect(err).toHaveBeenCalledWith(expect.stringContaining("[test] error message"));
    } finally {
      log.mockRestore();
      warn.mockRestore();
      err.mockRestore();
    }
  });

  it("child() produces a namespace-prefixed Logger that inherits level", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const root = new Logger({ namespace: "co", level: "debug" });
      const child = root.child("sub");
      child.info("hello", { task_id: "t-1" });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("[co/sub] hello {\"task_id\":\"t-1\"}"),
      );
    } finally {
      log.mockRestore();
    }
  });
});
