import { describe, it, expect } from "vitest";
import {
  RawConfigSchema,
  validateRawConfig,
  ConfigValidationError,
  ZkConfigSchema,
  CommandsConfigSchema,
  GitConfigSchema,
  HookCommandSchema,
  InitStatusEntrySchema,
} from "../src/config.js";

describe("ZkConfigSchema", () => {
  it("accepts valid zk config", () => {
    const result = ZkConfigSchema.safeParse({
      hosts: "127.0.0.1:2181",
      session_timeout_ms: 30000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty hosts", () => {
    const result = ZkConfigSchema.safeParse({
      hosts: "",
      session_timeout_ms: 30000,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("hosts");
    }
  });

  it("rejects negative session_timeout_ms", () => {
    const result = ZkConfigSchema.safeParse({
      hosts: "127.0.0.1:2181",
      session_timeout_ms: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer session_timeout_ms", () => {
    const result = ZkConfigSchema.safeParse({
      hosts: "127.0.0.1:2181",
      session_timeout_ms: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero session_timeout_ms", () => {
    const result = ZkConfigSchema.safeParse({
      hosts: "127.0.0.1:2181",
      session_timeout_ms: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("CommandsConfigSchema", () => {
  it("accepts valid commands config", () => {
    const result = CommandsConfigSchema.safeParse({
      claude_cli: "claude --dangerously-skip-permissions",
      git: "git",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty claude_cli", () => {
    const result = CommandsConfigSchema.safeParse({
      claude_cli: "",
      git: "git",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty git", () => {
    const result = CommandsConfigSchema.safeParse({
      claude_cli: "claude",
      git: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing claude_cli", () => {
    const result = CommandsConfigSchema.safeParse({
      git: "git",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing git", () => {
    const result = CommandsConfigSchema.safeParse({
      claude_cli: "claude",
    });
    expect(result.success).toBe(false);
  });
});

describe("GitConfigSchema", () => {
  it("accepts valid git config", () => {
    const result = GitConfigSchema.safeParse({
      merge_target_branch: "main",
      remote: "origin",
      auto_commit_init_files: true,
      auto_commit_init_files_branch: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts null values", () => {
    const result = GitConfigSchema.safeParse({
      merge_target_branch: null,
      remote: null,
      auto_commit_init_files: false,
      auto_commit_init_files_branch: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-boolean auto_commit_init_files", () => {
    const result = GitConfigSchema.safeParse({
      merge_target_branch: null,
      remote: null,
      auto_commit_init_files: "yes",
      auto_commit_init_files_branch: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string merge_target_branch", () => {
    const result = GitConfigSchema.safeParse({
      merge_target_branch: 123,
      remote: null,
      auto_commit_init_files: true,
      auto_commit_init_files_branch: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("HookCommandSchema", () => {
  it("accepts valid hook command", () => {
    const result = HookCommandSchema.safeParse({
      event: "task_completed",
      command: "echo done",
      enabled: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid event type", () => {
    const result = HookCommandSchema.safeParse({
      event: "invalid_event",
      command: "echo done",
      enabled: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty command", () => {
    const result = HookCommandSchema.safeParse({
      event: "task_completed",
      command: "",
      enabled: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-boolean enabled", () => {
    const result = HookCommandSchema.safeParse({
      event: "task_completed",
      command: "echo done",
      enabled: "yes",
    });
    expect(result.success).toBe(false);
  });
});

describe("InitStatusEntrySchema", () => {
  it("accepts valid init status entry", () => {
    const result = InitStatusEntrySchema.safeParse({
      step_id: "global-config",
      level: "Safe",
      decided_at: "2026-01-01T00:00:00Z",
      decision: "approved",
    });
    expect(result.success).toBe(true);
  });

  it("accepts all level values", () => {
    for (const level of ["Safe", "Caution", "Danger"]) {
      const result = InitStatusEntrySchema.safeParse({
        step_id: "test",
        level,
        decided_at: "2026-01-01T00:00:00Z",
        decision: "approved",
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts all decision values", () => {
    for (const decision of ["approved", "skipped", "auto"]) {
      const result = InitStatusEntrySchema.safeParse({
        step_id: "test",
        level: "Safe",
        decided_at: "2026-01-01T00:00:00Z",
        decision,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid level", () => {
    const result = InitStatusEntrySchema.safeParse({
      step_id: "test",
      level: "Invalid",
      decided_at: "2026-01-01T00:00:00Z",
      decision: "approved",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid decision", () => {
    const result = InitStatusEntrySchema.safeParse({
      step_id: "test",
      level: "Safe",
      decided_at: "2026-01-01T00:00:00Z",
      decision: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("RawConfigSchema", () => {
  it("accepts empty object (all fields optional)", () => {
    const result = RawConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts fully populated config", () => {
    const result = RawConfigSchema.safeParse({
      instance_id: "test-id",
      name: "TestProject",
      role: "leader",
      projects_root: "~/projects",
      zookeeper: { hosts: "zk:2181", session_timeout_ms: 5000 },
      commands: { claude_cli: "claude", git: "git" },
      git: {
        merge_target_branch: "main",
        remote: "origin",
        auto_commit_init_files: true,
        auto_commit_init_files_branch: null,
      },
      hooks: [
        { event: "task_completed", command: "echo done", enabled: true },
      ],
      init_status: [
        {
          step_id: "test",
          level: "Safe",
          decided_at: "2026-01-01",
          decision: "approved",
        },
      ],
      debug: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid role", () => {
    const result = RawConfigSchema.safeParse({
      role: "invalid-role",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid zookeeper config", () => {
    const result = RawConfigSchema.safeParse({
      zookeeper: { hosts: "", session_timeout_ms: 30000 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid hooks array", () => {
    const result = RawConfigSchema.safeParse({
      hooks: [{ event: "invalid", command: "cmd", enabled: true }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-object input", () => {
    const result = RawConfigSchema.safeParse("not an object");
    expect(result.success).toBe(false);
  });

  it("rejects null input", () => {
    const result = RawConfigSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects array input", () => {
    const result = RawConfigSchema.safeParse([]);
    expect(result.success).toBe(false);
  });

  it("accepts partial zookeeper config", () => {
    const result = RawConfigSchema.safeParse({
      zookeeper: { hosts: "zk:2181" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts partial git config", () => {
    const result = RawConfigSchema.safeParse({
      git: { remote: "upstream" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts partial commands config", () => {
    const result = RawConfigSchema.safeParse({
      commands: { git: "git" },
    });
    expect(result.success).toBe(true);
  });
});

describe("validateRawConfig", () => {
  it("returns parsed config on success", () => {
    const data = { debug: true, name: "test" };
    const result = validateRawConfig(data, "global");
    expect(result.debug).toBe(true);
    expect(result.name).toBe("test");
  });

  it("throws ConfigValidationError on invalid global config", () => {
    expect(() =>
      validateRawConfig({ zookeeper: { hosts: "" } }, "global"),
    ).toThrow(ConfigValidationError);
  });

  it("throws ConfigValidationError on invalid project config", () => {
    expect(() =>
      validateRawConfig({ role: "invalid" }, "project"),
    ).toThrow(ConfigValidationError);
  });

  it("error includes source in message", () => {
    try {
      validateRawConfig({ debug: "not-a-bool" }, "global");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).source).toBe("global");
    }
  });

  it("error includes source as project for project config", () => {
    try {
      validateRawConfig({ debug: "not-a-bool" }, "project");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).source).toBe("project");
    }
  });
});

describe("ConfigValidationError", () => {
  it("formatIssues produces readable output", () => {
    try {
      validateRawConfig(
        {
          zookeeper: { hosts: "" },
          commands: { git: "" },
        },
        "global",
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const formatted = (err as ConfigValidationError).formatIssues();
      expect(formatted).toContain("global config validation failed");
      expect(formatted).toContain("zk.hosts");
      expect(formatted).toContain("commands.git");
    }
  });

  it("error name is ConfigValidationError", () => {
    try {
      validateRawConfig({ debug: 123 }, "project");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as Error).name).toBe("ConfigValidationError");
    }
  });

  it("issues array contains all validation errors", () => {
    try {
      validateRawConfig(
        {
          zookeeper: { hosts: "", session_timeout_ms: -1 },
          commands: { claude_cli: "", git: "" },
        },
        "global",
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const issues = (err as ConfigValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(3);
    }
  });
});
