import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChildSupervisor, type ChildSupervisorOptions } from "../src/child-supervisor.js";
import { fork } from "node:child_process";

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => ({
    stdout: { resume: vi.fn() },
    stderr: { resume: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    exitCode: null,
    killed: false,
  })),
}));

describe("ChildSupervisor", () => {
  const defaultOpts: ChildSupervisorOptions = {
    child_module_path: "/test/module.js",
    zk_hosts: "localhost:2181",
    cli_command: "test-cli",
    projects_root: "/test",
    leader_instance_id: "leader-1",
    debug: false,
    git_remote: null,
    hooks: [],
    magic_mode: false,
    origin_branch: "main",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should use pipe for stdout/stderr instead of inherit", () => {
    const supervisor = new ChildSupervisor(defaultOpts);
    supervisor.start([{ worktree_path: "/wt", name: "worker-1", role: "worker", instance_id: "inst-1", branch: "main" }]);

    expect(fork).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
      })
    );
  });

  it("should resume stdout and stderr to prevent buffer deadlock", () => {
    const mockResume = vi.fn();
    vi.mocked(fork).mockReturnValueOnce({
      stdout: { resume: mockResume },
      stderr: { resume: mockResume },
      on: vi.fn(),
      kill: vi.fn(),
      exitCode: null,
      killed: false,
    } as any);

    const supervisor = new ChildSupervisor(defaultOpts);
    supervisor.start([{ worktree_path: "/wt", name: "worker-1", role: "worker", instance_id: "inst-1", branch: "main" }]);

    expect(mockResume).toHaveBeenCalledTimes(2);
  });

  it("should restart worker on non-zero exit code", () => {
    const mockOn = vi.fn();
    vi.mocked(fork).mockReturnValue({
      stdout: { resume: vi.fn() },
      stderr: { resume: vi.fn() },
      on: mockOn,
      kill: vi.fn(),
      exitCode: null,
      killed: false,
    } as any);

    const supervisor = new ChildSupervisor(defaultOpts);
    supervisor.start([{ worktree_path: "/wt", name: "worker-1", role: "worker", instance_id: "inst-1", branch: "main" }]);

    // Get the exit handler
    const exitHandler = mockOn.mock.calls.find((call: any[]) => call[0] === "exit")?.[1];
    expect(exitHandler).toBeDefined();

    // Simulate non-zero exit
    exitHandler(1);

    // Should warn about restart (logger.warn is called with just the message string)
    expect(defaultOpts.logger.warn).toHaveBeenCalledWith(
      "worker worker-1 exited (1); restart 1/3"
    );
  });

  it("should not restart worker after max restarts", () => {
    const mockOn = vi.fn();
    vi.mocked(fork).mockReturnValue({
      stdout: { resume: vi.fn() },
      stderr: { resume: vi.fn() },
      on: mockOn,
      kill: vi.fn(),
      exitCode: null,
      killed: false,
    } as any);

    const supervisor = new ChildSupervisor(defaultOpts);
    supervisor.start([{ worktree_path: "/wt", name: "worker-1", role: "worker", instance_id: "inst-1", branch: "main" }]);

    // Get the exit handler
    const exitHandler = mockOn.mock.calls.find((call: any[]) => call[0] === "exit")?.[1];
    expect(exitHandler).toBeDefined();

    // Simulate 4 non-zero exits (MAX_RESTARTS = 3)
    for (let i = 0; i < 4; i++) {
      exitHandler(1);
    }

    // Should error about max restarts (logger.error is called with just the message string)
    expect(defaultOpts.logger.error).toHaveBeenCalledWith(
      "worker worker-1 exited (1) after max restarts"
    );
  });

  it("should kill workers on shutdown", async () => {
    const mockKill = vi.fn();
    vi.mocked(fork).mockReturnValue({
      stdout: { resume: vi.fn() },
      stderr: { resume: vi.fn() },
      on: vi.fn(),
      kill: mockKill,
      exitCode: 0, // Already exited
      killed: false,
    } as any);

    const supervisor = new ChildSupervisor(defaultOpts);
    supervisor.start([{ worktree_path: "/wt", name: "worker-1", role: "worker", instance_id: "inst-1", branch: "main" }]);

    await supervisor.shutdown();

    expect(mockKill).toHaveBeenCalledWith("SIGTERM");
  });

  it("should use SIGKILL after timeout", async () => {
    const mockKill = vi.fn();
    vi.mocked(fork).mockReturnValue({
      stdout: { resume: vi.fn() },
      stderr: { resume: vi.fn() },
      on: vi.fn(),
      kill: mockKill,
      exitCode: null, // Not exited
      killed: false,
    } as any);

    const supervisor = new ChildSupervisor(defaultOpts);
    supervisor.start([{ worktree_path: "/wt", name: "worker-1", role: "worker", instance_id: "inst-1", branch: "main" }]);

    // Use very short timeout for test
    await supervisor.shutdown(100);

    // Should have tried SIGTERM first, then SIGKILL
    expect(mockKill).toHaveBeenCalledWith("SIGTERM");
    expect(mockKill).toHaveBeenCalledWith("SIGKILL");
  });
});
