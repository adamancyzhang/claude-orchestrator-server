import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChildSupervisor, type ChildSupervisorOptions } from "../src/child-supervisor.js";
import { fork } from "node:child_process";

// TRUST-JUSTIFICATION: We mock fork() because ChildSupervisor's behavior
// is about process lifecycle management (restart on exit, SIGTERM/SIGKILL
// on shutdown), not about what the child process does. The mock allows us
// to simulate different exit scenarios (exit code 1, process ignoring
// SIGTERM) without actually spawning processes. This is appropriate for
// unit testing the supervisor's decision logic.
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

  it("should use SIGKILL after timeout when process ignores SIGTERM", async () => {
    // Mock fork to return a process that ignores SIGTERM (exitCode stays null)
    const mockKill = vi.fn();
    const mockOn = vi.fn();
    vi.mocked(fork).mockReturnValue({
      stdout: { resume: vi.fn() },
      stderr: { resume: vi.fn() },
      on: mockOn,
      kill: mockKill,
      exitCode: null, // Process never exits
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

  it("should not send SIGKILL if process exits after SIGTERM", async () => {
    // Create a mock child process that simulates exiting when SIGTERM is sent
    const mockKill = vi.fn();
    const mockOn = vi.fn();
    const mockChild = {
      stdout: { resume: vi.fn() },
      stderr: { resume: vi.fn() },
      on: mockOn,
      kill: mockKill,
      exitCode: null as number | null,
      killed: false,
    };

    vi.mocked(fork).mockReturnValue(mockChild as any);

    const supervisor = new ChildSupervisor(defaultOpts);
    supervisor.start([{ worktree_path: "/wt", name: "worker-1", role: "worker", instance_id: "inst-1", branch: "main" }]);

    // Get the exit handler
    const exitHandler = mockOn.mock.calls.find((call: any[]) => call[0] === "exit")?.[1];
    expect(exitHandler).toBeDefined();

    // Override kill to simulate process exiting after SIGTERM
    mockKill.mockImplementation(() => {
      // Simulate the process exiting after SIGTERM by updating exitCode
      mockChild.exitCode = 0;
      // Call the exit handler to notify the supervisor
      if (exitHandler) exitHandler(0);
    });

    await supervisor.shutdown(500);

    // Should have sent SIGTERM but NOT SIGKILL since process exited
    expect(mockKill).toHaveBeenCalledWith("SIGTERM");
    expect(mockKill).not.toHaveBeenCalledWith("SIGKILL");
  });
});
