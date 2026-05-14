import {
  asTaskId,
  asInstanceId,
  asChainId,
  ROLE_WEIGHTS,
  TaskSchema,
  ValidationError,
  ZkNodeNotFoundError,
  zkPaths,
  type ClaimRecord,
  type CreateTaskInput,
  type ITaskQueue,
  type IZkClient,
  type InstanceId,
  type InstanceRole,
  type Task,
  type TaskId,
  type ZkPathOptions,
} from "@co/contracts";

function utcNow(): string {
  return new Date().toISOString();
}

function encode(data: unknown): Buffer {
  return Buffer.from(JSON.stringify(data), "utf-8");
}

function decode<T>(buf: Buffer): T {
  return JSON.parse(buf.toString("utf-8")) as T;
}

function parseTask(raw: unknown): Task {
  const result = TaskSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError("invalid task payload", result.error);
  }
  return result.data;
}

export interface TaskQueueOptions {
  zk: IZkClient;
  paths?: ZkPathOptions;
}

export class TaskQueue implements ITaskQueue {
  private readonly zk: IZkClient;
  private readonly paths: ZkPathOptions | undefined;

  constructor(opts: TaskQueueOptions) {
    this.zk = opts.zk;
    this.paths = opts.paths;
  }

  async push(input: CreateTaskInput): Promise<Task> {
    const payload = {
      title: input.title,
      description: input.description ?? "",
      priority: input.priority ?? 1,
      status: "pending" as const,
      link: input.link ?? null,
      chain_id: input.chain_id ?? null,
      task_doc_path: input.task_doc_path ?? null,
      result_path: input.result_path ?? null,
      retry_count: 0,
      depends_on: input.depends_on ?? [],
      blocked_by: input.blocked_by ?? [],
      blocked_reason: null,
      fail_reason: null,
      created_by: input.created_by ?? null,
      created_by_name: input.created_by_name ?? "",
      assigned_to: input.assigned_to ?? null,
      assigned_to_name: input.assigned_to_name ?? null,
      claimed_by: null,
      completed_by_name: null,
      created_at: utcNow(),
      claimed_at: null,
      completed_at: null,
      duration_seconds: null,
      leader_only: input.leader_only ?? false,
      result: null,
    };
    const createdPath = await this.zk.createPersistentSequential(
      zkPaths.tasksPending(this.paths),
      "task-",
      encode(payload),
    );
    const taskId = asTaskId(createdPath.split("/").pop()!);
    return parseTask({ ...payload, id: taskId });
  }

  async claim(claimer: InstanceId, role: InstanceRole): Promise<Task | null> {
    const pendingIds = await this.zk.getChildren(zkPaths.tasksPending(this.paths));
    pendingIds.sort();

    type Candidate = { id: TaskId; task: Task; key: [number, number, number, string] };
    const candidates: Candidate[] = [];
    for (const id of pendingIds) {
      const result = await this.zk.getData(
        zkPaths.taskPending(asTaskId(id), this.paths),
      );
      if (!result) continue;
      const raw = decode<Record<string, unknown>>(result.data);
      const task = parseTask({ ...raw, id });
      if (task.leader_only && role !== "leader") continue;
      const link = task.link;
      const weight = link ? ROLE_WEIGHTS[role][link] : 0;
      if (weight === 0 && link !== null && role !== "leader") continue;
      const assignedMatch = task.assigned_to === claimer ? 0 : 1;
      // Sort: assigned match (0 first) → weight DESC → priority ASC → FIFO.
      candidates.push({
        id: asTaskId(id),
        task,
        key: [assignedMatch, -weight, task.priority, id],
      });
    }

    candidates.sort((a, b) => {
      for (let i = 0; i < a.key.length; i++) {
        if (a.key[i] < b.key[i]) return -1;
        if (a.key[i] > b.key[i]) return 1;
      }
      return 0;
    });

    for (const { id, task } of candidates) {
      const claimedAt = utcNow();
      const record: ClaimRecord = {
        task_id: id,
        instance_id: claimer,
        claimed_at: claimedAt,
        task_snapshot: task,
      };
      try {
        await this.zk.createEphemeral(
          zkPaths.taskClaimed(claimer, id, this.paths),
          encode(record),
        );
      } catch {
        // Lost the race for this task; try the next candidate.
        continue;
      }
      await this.zk.delete(zkPaths.taskPending(id, this.paths)).catch(() => {});
      return {
        ...task,
        id,
        status: "claimed",
        claimed_at: claimedAt,
        claimed_by: claimer,
      };
    }
    return null;
  }

  async complete(
    taskId: TaskId,
    result: string,
    by: InstanceId,
    completedByName: string,
    durationSeconds: number | null,
  ): Promise<void> {
    const claimPath = zkPaths.taskClaimed(by, taskId, this.paths);
    const data = await this.zk.getData(claimPath);
    if (!data) throw new ZkNodeNotFoundError(`claim missing: ${claimPath}`);
    const record = decode<ClaimRecord>(data.data);
    const snapshot = record.task_snapshot ?? null;
    const now = utcNow();
    const completed: Task = parseTask({
      ...(snapshot ?? {}),
      id: taskId,
      status: "completed" as const,
      claimed_by: by,
      claimed_at: record.claimed_at,
      completed_at: now,
      completed_by_name: completedByName,
      duration_seconds: durationSeconds,
      result,
    });
    await this.zk.createPersistent(
      zkPaths.taskCompleted(taskId, this.paths),
      encode(completed),
    );
    await this.zk.delete(claimPath);
  }

  async block(taskId: TaskId, reason: string): Promise<void> {
    const ids = await this.zk.getChildren(zkPaths.tasksClaimed(this.paths));
    const target = ids.find((s) => s.endsWith(`-${taskId}`));
    if (!target) throw new ZkNodeNotFoundError(`no claim for ${taskId}`);
    const fullPath = zkPaths.tasksClaimed(this.paths);
    const data = await this.zk.getData(
      (`${fullPath}/${target}`) as ReturnType<typeof zkPaths.tasksClaimed>,
    );
    if (!data) throw new ZkNodeNotFoundError(`claim missing: ${target}`);
    const record = decode<ClaimRecord>(data.data);
    if (record.task_snapshot) {
      record.task_snapshot = {
        ...record.task_snapshot,
        status: "blocked",
        blocked_reason: reason,
      };
    }
    await this.zk.setData(
      (`${fullPath}/${target}`) as ReturnType<typeof zkPaths.tasksClaimed>,
      encode(record),
    );
  }

  async fail(taskId: TaskId, reason: string): Promise<void> {
    const ids = await this.zk.getChildren(zkPaths.tasksClaimed(this.paths));
    const target = ids.find((s) => s.endsWith(`-${taskId}`));
    const fullPath = zkPaths.tasksClaimed(this.paths);
    let snapshot: Task | null = null;
    if (target) {
      const data = await this.zk.getData(
        (`${fullPath}/${target}`) as ReturnType<typeof zkPaths.tasksClaimed>,
      );
      if (data) {
        const record = decode<ClaimRecord>(data.data);
        snapshot = record.task_snapshot ?? null;
      }
      await this.zk
        .delete(
          (`${fullPath}/${target}`) as ReturnType<typeof zkPaths.tasksClaimed>,
        )
        .catch(() => {});
    } else {
      const pendingData = await this.zk.getData(
        zkPaths.taskPending(taskId, this.paths),
      );
      if (pendingData) {
        snapshot = parseTask({ ...decode<Record<string, unknown>>(pendingData.data), id: taskId });
        await this.zk
          .delete(zkPaths.taskPending(taskId, this.paths))
          .catch(() => {});
      }
    }
    const now = utcNow();
    const failed: Task = parseTask({
      ...(snapshot ?? { title: taskId, created_at: now }),
      id: taskId,
      status: "failed" as const,
      fail_reason: reason,
      completed_at: now,
      result: `Failed: ${reason}`,
    });
    await this.zk.createPersistent(
      zkPaths.taskCompleted(taskId, this.paths),
      encode(failed),
    );
  }

  async retry(taskId: TaskId): Promise<Task> {
    const completedPath = zkPaths.taskCompleted(taskId, this.paths);
    const data = await this.zk.getData(completedPath);
    if (!data) throw new ZkNodeNotFoundError(`completed missing: ${taskId}`);
    const original = parseTask(decode<Record<string, unknown>>(data.data));
    const retryCount = (original.retry_count ?? 0) + 1;
    const payload = {
      ...original,
      id: "",
      status: "pending" as const,
      retry_count: retryCount,
      created_at: utcNow(),
      claimed_at: null,
      claimed_by: null,
      completed_at: null,
      completed_by_name: null,
      duration_seconds: null,
      fail_reason: null,
      result: null,
    };
    const createdPath = await this.zk.createPersistentSequential(
      zkPaths.tasksPending(this.paths),
      "task-",
      encode(payload),
    );
    const newId = asTaskId(createdPath.split("/").pop()!);
    return parseTask({ ...payload, id: newId });
  }

  async listPending(): Promise<Task[]> {
    const ids = await this.zk.getChildren(zkPaths.tasksPending(this.paths));
    ids.sort();
    const out: Task[] = [];
    for (const id of ids) {
      const data = await this.zk.getData(
        zkPaths.taskPending(asTaskId(id), this.paths),
      );
      if (!data) continue;
      out.push(parseTask({ ...decode<Record<string, unknown>>(data.data), id }));
    }
    return out;
  }

  async listClaimed(): Promise<ClaimRecord[]> {
    const ids = await this.zk.getChildren(zkPaths.tasksClaimed(this.paths));
    ids.sort();
    const out: ClaimRecord[] = [];
    const root = zkPaths.tasksClaimed(this.paths);
    for (const id of ids) {
      const data = await this.zk.getData(
        (`${root}/${id}`) as ReturnType<typeof zkPaths.tasksClaimed>,
      );
      if (!data) continue;
      out.push(decode<ClaimRecord>(data.data));
    }
    return out;
  }

  async getPending(taskId: TaskId): Promise<Task | null> {
    const data = await this.zk.getData(zkPaths.taskPending(taskId, this.paths));
    if (!data) return null;
    return parseTask({ ...decode<Record<string, unknown>>(data.data), id: taskId });
  }

  async getCompleted(taskId: TaskId): Promise<Task | null> {
    const data = await this.zk.getData(zkPaths.taskCompleted(taskId, this.paths));
    if (!data) return null;
    return parseTask({ ...decode<Record<string, unknown>>(data.data), id: taskId });
  }

  async watchPending(cb: (children: TaskId[]) => void): Promise<TaskId[]> {
    const adapt = (ids: string[]) => cb(ids.map((s) => asTaskId(s)));
    const initial = await this.zk.watchChildren(
      zkPaths.tasksPending(this.paths),
      adapt,
    );
    return initial.map((s) => asTaskId(s));
  }

  async watchClaimed(
    cb: (records: ClaimRecord[]) => void,
  ): Promise<ClaimRecord[]> {
    const adapt = async (_ids: string[]) => {
      const records = await this.listClaimed();
      cb(records);
    };
    await this.zk.watchChildren(zkPaths.tasksClaimed(this.paths), adapt);
    return this.listClaimed();
  }
}

export function parseClaimedNodeName(
  name: string,
): { instance_id: InstanceId; task_id: TaskId } | null {
  const idx = name.indexOf("-task-");
  if (idx === -1) return null;
  return {
    instance_id: asInstanceId(name.slice(0, idx)),
    task_id: asTaskId(name.slice(idx + 1)),
  };
}

export { asChainId };
