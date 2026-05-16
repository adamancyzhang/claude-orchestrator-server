# Core Chain 5 — Worker 失联 → 孤儿检测 → 重试/归档

> **链路定位**：Worker 崩溃或 ZK Session 超时后，Recovery 检测孤儿 claimed 任务，根据 retry_count 决定重新入队或归档为 failed。这是系统自愈能力的核心。

## 1. 链路总览

```
Worker 子进程崩溃 / ZK Session 超时
    │
    ▼
/instances/{id} EPHEMERAL 自动删除     ← ZK 自动行为
/tasks/claimed/{id}-{task} EPHEMERAL 删除 ← ZK 自动行为
    │
    ▼
Leader 检测:
    ├─ 启动时: Recovery.scanOrphans()
    │     └─ 扫描 /tasks/claimed 中无对应 instance 的项
    │
    └─ 运行时: TaskOrchestrator ChildWatch 触发
          └─ 某 claimed 节点删除 + instance 不存在
    │
    ▼
rec reclaim(taskSnapshot):
    ├─ retry_count >= 3 → 归档 /tasks/completed/{id} (status=failed)
    └─ retry_count < 3  → retry_count++ → push /tasks/pending/task-{newSeq}
```

## 2. 触发时机

### 2.1 Leader 启动时一次性扫描

```typescript
class Recovery {
  async scanOrphans(): Promise<void> {
    const claimedNodes = await zk.getChildren(paths.TASKS_CLAIMED);
    const instances = await instanceRegistry.list();
    const instanceIds = new Set(instances.map(i => i.id));

    for (const nodeName of claimedNodes) {
      const { instanceId, taskId } = parseClaimedNodeName(nodeName);

      if (!instanceIds.has(instanceId)) {
        // 孤儿：Worker 已不在线
        const nodeData = await zk.getData(paths.taskClaimed(instanceId, taskId));
        const claimRecord = JSON.parse(nodeData.data.toString());
        await this.reclaim(claimRecord.task_snapshot);
      }
    }
  }
}
```

### 2.2 运行时持续监测

```typescript
class TaskOrchestrator {
  async start(): Promise<void> {
    // Watch /tasks/claimed
    this.zk.getChildrenWithWatch(paths.TASKS_CLAIMED, async (children) => {
      const prevSet = new Set(this.knownClaimed);
      const currSet = new Set(children);

      // 检测被删除的 claimed 节点
      for (const nodeName of prevSet) {
        if (!currSet.has(nodeName)) {
          const { instanceId, taskId } = parseClaimedNodeName(nodeName);

          // 检查 instance 是否还存在
          const instExists = await this.zk.exists(paths.instancePath(instanceId));
          if (!instExists) {
            // instance 不存在 → 孤儿 → 回收
            await this.recoverOrphanedTask(instanceId, taskId);
          }
          // instance 存在 → 正常完成（Worker 主动 complete）
        }
      }

      this.knownClaimed = children;
    });
  }
}
```

## 3. 回收逻辑

```typescript
async reclaim(taskSnapshot: Task): Promise<void> {
  if (taskSnapshot.retry_count >= MAX_RETRY) {
    // 归档为 failed
    await taskQueue.fail(taskSnapshot.id, `Orphan retry exhausted (${taskSnapshot.retry_count} retries)`);

    eventBus.emit({
      type: "task_failed",
      taskId: taskSnapshot.id,
      reason: `Orphan retry count ${taskSnapshot.retry_count} >= ${MAX_RETRY}`,
    });

    throw new OrphanRetryExhaustedError(
      "ORPHAN_RETRY_EXHAUSTED",
      `Task ${taskSnapshot.id} orphan retry exhausted after ${MAX_RETRY} attempts`,
    );
  }

  // 重新入队 pending
  const retryTask = {
    ...taskSnapshot,
    retry_count: taskSnapshot.retry_count + 1,
    status: "pending" as const,
    claimed_by: null,
    claimed_at: null,
    claimed_by_name: null,
  };

  await taskQueue.push({
    title: retryTask.title,
    description: retryTask.description,
    priority: retryTask.priority,
    link: retryTask.link,
    chain_id: retryTask.chain_id,
    depends_on: retryTask.depends_on,
    created_by: retryTask.created_by,
    assigned_to: retryTask.assigned_to,
  });
  // 注意: push 会创建新的 task-{seq} ID

  eventBus.emit({
    type: "task_recovered",
    taskId: taskSnapshot.id,
    retry_count: retryTask.retry_count,
  });
}
```

`MAX_RETRY = 3` 是协议常量，不通过配置开放（避免不同实例策略漂移）。

## 4. Worker 端恢复

### 4.1 子进程崩溃 → 父进程重启

```typescript
// run.ts Phase 4
child.on("exit", (code) => {
  if (code !== 0 && code !== null && !shuttingDown) {
    const retries = restartCount.get(cfg.name) ?? 0;
    if (retries < 3) {
      logger.warn(`Worker ${cfg.name} crashed (exit=${code}), restart ${retries + 1}/3`);
      restartCount.set(cfg.name, retries + 1);
      spawnChild(cfg);  // 重新 fork
    } else {
      logger.error(`Worker ${cfg.name} restarted 3 times, giving up`);
      eventBus.emit({ type: "worker_left", instanceId: cfg.instanceId, name: cfg.name });
    }
  }
});
```

`restartCount` 在父进程内存中维护，不持久化。

### 4.2 父进程崩溃 → 子进程自杀

```typescript
// child-runner.ts
function startParentAliveCheck(watcher: WorkerWatcher, zk: ZkClient) {
  const parentPid = process.ppid;
  return setInterval(() => {
    try {
      process.kill(parentPid, 0);  // 探测
    } catch {
      logger.warn("Parent process died, child exiting");
      watcher.stop();
      zk.disconnect();
      process.exit(1);
    }
  }, 1000);
}
```

防止孤儿 Worker 继续抢任务。

## 5. Leader 崩溃恢复

```
Leader 进程异常退出
  → /leader EPHEMERAL 自动删除
  → Worker 检测 /leader 消失 → 进入 idle 等待（不退出）
  → 操作员重新执行 claude-orchestrator run --worker N
    → InitChecker 跳过已完成步骤（基于 init_status）
    → WorktreeInitializer 检测 worktree 已存在 → 跳过
    → startLeader() → 创建新的 /leader 节点
    → Recovery.scanOrphans() → 扫描 /tasks/claimed 中 instance 不存在的项
    → 现存 Worker 继续工作（消息流自然续接）
```

注意：v0.6 不实现 Leader 热备。Leader 重启窗口期 Worker 处于"已分派任务可继续执行，新任务进 pending 等待"的状态。

## 6. ZK Session 事件处理

### Worker ZK Session Expired

Worker 在 ZK session expired 时**不**杀掉当前 `claude -p` 子进程：

- `/tasks/claimed/{ins}-{task}` EPHEMERAL 已消失 → Leader Recovery 视为孤儿
- 旧 Worker 完成任务后尝试发 completion_report，但目标消息队列已被 Recovery 视为重派的新任务接管
- 缓解：ChainRouter 收到 completion_report 时校验 `task` 当前 status 是否仍为 `claimed by this instance`；不是则丢弃 + 警告

## 7. 链路产出

| 产出 | 说明 |
|------|------|
| task_recovered 事件 | 孤儿任务重新入队 |
| task_failed 事件 | 重试超限归档 |
| 重启的 Worker 子进程 | 父进程自动重启（最多 3 次） |
| EVENT LOG 记录 | TUI 显示恢复动作 |

## 8. 错误处理

| 场景 | 处理 |
|------|------|
| 孤儿 retry >= 3 | 归档 failed，抛 OrphanRetryExhaustedError（被 Recovery 自身捕获） |
| ZK 读取孤儿数据失败 | 跳过该孤儿，记录错误日志 |
| 重新 push 失败 | ZK 写入错误，重试 1 次后抛错到边界 |
| 子进程重启超 3 次 | 标记 worker.status = "failed"，发 worker_left 事件 |
