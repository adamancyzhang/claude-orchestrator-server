export class CoError extends Error {
  public readonly code: string;
  public readonly cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = new.target.name;
  }
}

// ── ZK ──
export class ZkError extends CoError {}
export class ZkSessionExpiredError extends ZkError {
  constructor(message = "ZK session expired", cause?: unknown) {
    super("ZK_SESSION_EXPIRED", message, cause);
  }
}
export class ZkNodeExistsError extends ZkError {
  constructor(message = "ZK node exists", cause?: unknown) {
    super("ZK_NODE_EXISTS", message, cause);
  }
}
export class ZkNodeNotFoundError extends ZkError {
  constructor(message = "ZK node not found", cause?: unknown) {
    super("ZK_NODE_NOT_FOUND", message, cause);
  }
}

// ── Protocol / validation ──
export class ValidationError extends CoError {
  constructor(message: string, cause?: unknown) {
    super("VALIDATION_FAILED", message, cause);
  }
}
export class ProtocolVersionMismatchError extends CoError {
  constructor(expected: string, actual: string) {
    super(
      "PROTOCOL_VERSION_MISMATCH",
      `Protocol version mismatch: expected ${expected}, got ${actual}`,
    );
  }
}

// ── Runtime ──
export class ClaudeRunnerError extends CoError {
  constructor(message: string, cause?: unknown) {
    super("CLAUDE_RUNNER_FAILED", message, cause);
  }
}
export class TemplateNotFoundError extends CoError {
  constructor(name: string) {
    super("TEMPLATE_NOT_FOUND", `Template not found: ${name}`);
  }
}
export class HookError extends CoError {
  constructor(message: string, cause?: unknown) {
    super("HOOK_FAILED", message, cause);
  }
}

// ── Business ──
export class MergeConflictError extends CoError {
  constructor(message: string, public readonly conflict_files: string[] = []) {
    super("MERGE_CONFLICT", message);
  }
}
export class WorktreeError extends CoError {
  constructor(message: string, cause?: unknown) {
    super("WORKTREE_FAILED", message, cause);
  }
}
export class OrphanRetryExhaustedError extends CoError {
  constructor(taskId: string, retryCount: number) {
    super(
      "ORPHAN_RETRY_EXHAUSTED",
      `Task ${taskId} exceeded ${retryCount} retries; archived as failed`,
    );
  }
}
export class ChainConflictError extends CoError {
  constructor(
    chainId: string,
    public readonly existing_status: string,
    public readonly existing_completed_at: string | null,
  ) {
    super(
      "CHAIN_ID_CONFLICT",
      `Chain ${chainId} already exists with status=${existing_status}` +
        (existing_completed_at ? ` (closed at ${existing_completed_at})` : ""),
    );
  }
}
export class CommitFailedError extends CoError {
  constructor(message: string, public readonly stderr: string, cause?: unknown) {
    super("WORKER_COMMIT_FAILED", message, cause);
  }
}
export class WorktreeLockedError extends CoError {
  constructor(message: string, public readonly stderr: string = "", cause?: unknown) {
    super("WORKTREE_LOCKED", message, cause);
  }
}
export class GitPermissionError extends CoError {
  constructor(message: string, public readonly stderr: string = "", cause?: unknown) {
    super("GIT_PERMISSION_DENIED", message, cause);
  }
}
export class GitNetworkError extends CoError {
  constructor(message: string, public readonly stderr: string = "", cause?: unknown) {
    super("GIT_NETWORK_FAILED", message, cause);
  }
}
export class RebaseConflictError extends CoError {
  constructor(message: string, public readonly conflict_files: string[] = [], cause?: unknown) {
    super("REBASE_CONFLICT", message, cause);
  }
}
export class MagicDepthExhaustedError extends CoError {
  constructor(
    public readonly chain_depth: number,
    public readonly max_chains: number,
  ) {
    super(
      "MAGIC_DEPTH_EXHAUSTED",
      `Magic chain depth ${chain_depth} reached --magic-max-chains=${max_chains}`,
    );
  }
}
