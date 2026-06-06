// CORE-RETENTION
// Locks in: Logger's level filtering, namespace formatting, context
// serialization, and child logger inheritance.
// Critical because: Logger is the primary observability mechanism. A level
// filtering bug causes noisy debug logs in production or silences errors.
// Primary sources: packages/infra/src/logger.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Logger } from "../src/logger.js";

describe("Logger — level filtering", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("default level is 'info' — debug messages are suppressed", () => {
    const logger = new Logger({ namespace: "test" });
    logger.debug("should not appear");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("default level is 'info' — info messages are emitted", () => {
    const logger = new Logger({ namespace: "test" });
    logger.info("hello");
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it("default level is 'info' — warn messages are emitted", () => {
    const logger = new Logger({ namespace: "test" });
    logger.warn("warning");
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("default level is 'info' — error messages are emitted", () => {
    const logger = new Logger({ namespace: "test" });
    logger.error("failure");
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("level 'debug' allows all messages", () => {
    const logger = new Logger({ namespace: "test", level: "debug" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(logSpy).toHaveBeenCalledTimes(2); // debug + info
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("level 'error' suppresses debug, info, and warn", () => {
    const logger = new Logger({ namespace: "test", level: "error" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("level 'warn' allows warn and error only", () => {
    const logger = new Logger({ namespace: "test", level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});

describe("Logger — formatting", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("prefixes output with [namespace]", () => {
    const logger = new Logger({ namespace: "my-module" });
    logger.info("test message");
    expect(logSpy).toHaveBeenCalledWith("[my-module] test message");
  });

  it("serializes context as JSON suffix", () => {
    const logger = new Logger({ namespace: "test" });
    logger.info("with ctx", { key: "value", num: 42 });
    expect(logSpy).toHaveBeenCalledWith(
      '[test] with ctx {"key":"value","num":42}',
    );
  });

  it("omits context suffix when ctx is empty", () => {
    const logger = new Logger({ namespace: "test" });
    logger.info("no ctx", {});
    expect(logSpy).toHaveBeenCalledWith("[test] no ctx");
  });

  it("omits context suffix when ctx is undefined", () => {
    const logger = new Logger({ namespace: "test" });
    logger.info("no ctx");
    expect(logSpy).toHaveBeenCalledWith("[test] no ctx");
  });

  it("default namespace is 'co'", () => {
    const logger = new Logger();
    logger.info("default ns");
    expect(logSpy).toHaveBeenCalledWith("[co] default ns");
  });

  it("warn and error use appropriate console methods", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new Logger({ namespace: "test" });

    logger.warn("w");
    logger.error("e");

    expect(warnSpy).toHaveBeenCalledWith("[test] w");
    expect(errorSpy).toHaveBeenCalledWith("[test] e");

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("Logger — child", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("child logger inherits level from parent", () => {
    const parent = new Logger({ namespace: "parent", level: "error" });
    const child = parent.child("child");
    child.info("should not appear");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("child logger appends namespace with slash separator", () => {
    const parent = new Logger({ namespace: "root" });
    const child = parent.child("sub");
    child.info("test");
    expect(logSpy).toHaveBeenCalledWith("[root/sub] test");
  });

  it("nested child logger chains namespaces", () => {
    const root = new Logger({ namespace: "a" });
    const mid = root.child("b");
    const leaf = mid.child("c");
    leaf.info("deep");
    expect(logSpy).toHaveBeenCalledWith("[a/b/c] deep");
  });

  it("child logger is an independent ILogger instance", () => {
    const parent = new Logger({ namespace: "parent" });
    const child = parent.child("child");
    expect(typeof child.info).toBe("function");
    expect(typeof child.debug).toBe("function");
    expect(typeof child.warn).toBe("function");
    expect(typeof child.error).toBe("function");
    expect(typeof child.child).toBe("function");
  });
});

describe("Logger — JSON format", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("outputs valid JSON when format is 'json'", () => {
    const logger = new Logger({ namespace: "test", format: "json" });
    logger.info("hello");
    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe("info");
    expect(parsed.ns).toBe("test");
    expect(parsed.msg).toBe("hello");
    expect(parsed.ts).toBeDefined();
  });

  it("includes context fields in JSON output", () => {
    const logger = new Logger({ namespace: "test", format: "json" });
    logger.info("with ctx", { key: "value", num: 42 });
    const output = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.key).toBe("value");
    expect(parsed.num).toBe(42);
  });

  it("child logger inherits JSON format", () => {
    const parent = new Logger({ namespace: "parent", format: "json" });
    const child = parent.child("child");
    child.info("from child");
    const output = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.ns).toBe("parent/child");
    expect(parsed.msg).toBe("from child");
  });

  it("JSON format uses appropriate console method per level", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = new Logger({ namespace: "test", format: "json" });
    logger.warn("w");
    logger.error("e");

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
    const warnOutput = JSON.parse(warnSpy.mock.calls[0][0] as string);
    const errorOutput = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(warnOutput.level).toBe("warn");
    expect(errorOutput.level).toBe("error");

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
