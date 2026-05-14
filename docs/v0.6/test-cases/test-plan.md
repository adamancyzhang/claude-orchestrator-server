# Test Plan — v0.6 测试策略

> **文档定位**：定义 v0.6 的测试策略、方法论、环境要求。具体测试用例见 `tc-*.md` 文件。
> **覆盖范围**：仅覆盖五条核心链路。非核心功能（CLI 命令、配置加载、TUI 渲染等）不在本测试计划范围内。

## 1. 测试方法论：渐进式测试

### 1.1 核心理念

从**最小可验证单元**开始，逐步扩展到**完整链路**。每一层测试通过后才进入下一层。

```
Level 1: 单点测试（Point）
    │  验证单个操作的正确性
    │  例: "创建一个 pending 任务"
    │
    ▼
Level 2: 双点对接（Edge）
    │  验证两个相邻操作的交互
    │  例: "创建任务 → 认领任务"
    │
    ▼
Level 3: 短链测试（Segment）
    │  验证 3-4 步的子链路
    │  例: "创建 → 认领 → 执行 → 完成"
    │
    ▼
Level 4: 全链测试（End-to-End）
    │  验证完整端到端链路
    │  例: "需求输入 → 拆解 → 任务创建 → 认领 → 执行 → 评估 → 推进 → 合并 → 关闭"
    │
    ▼
Level 5: 异常路径测试（Resilience）
       验证链路中的故障恢复
       例: "Worker 崩溃 → 孤儿回收 → 重试 → 成功"
```

### 1.2 渐进式的好处

| 优势 | 说明 |
|------|------|
| **快速定位** | 单点测试失败 → 问题精确到操作 |
| **低耦合** | 每一层只依赖下一层已验证的行为 |
| **可并行** | 同层测试可并行执行 |
| **渐进信心** | 从"操作正确"到"链路正确"，逐步建立信心 |

## 2. 测试环境

### 2.1 依赖

| 组件 | 用途 | 说明 |
|------|------|------|
| ZooKeeper | 分布式状态 | Docker: `docker-compose up -d`，端口 2181 |
| Git | 版本控制 | 本地仓库，含 worktree 支持 |
| claude CLI | LLM 调用 | 测试中用 mock 替代 |

### 2.2 Mock 策略

| 组件 | 测试方式 | 原因 |
|------|---------|------|
| ZooKeeper | **真实实例** | ZK 是核心依赖，EPHEMERAL/SEQUENTIAL 行为难以 mock |
| claude CLI | **Mock** | LLM 输出不确定，测试中用预设 fixture 替代 |
| Git | **真实仓库** | worktree 行为依赖真实 git，但测试在临时目录中进行 |
| 文件系统 | **临时目录** | 每个测试用例独立 tmp dir |

### 2.3 测试框架

- **Vitest** — 与项目一致
- ZK 连接：每次测试前清理 `/claude-orchestrator` 树，保证隔离

```typescript
beforeEach(async () => {
  // 清理 ZK
  await zk.deleteRecursive("/claude-orchestrator");
  // 重新创建基础路径
  await zk.mkdirp("/claude-orchestrator");
});

afterAll(async () => {
  await zk.disconnect();
});
```

## 3. 测试数据约定

### 3.1 Fixture 文件

```typescript
// tests/fixtures/eval-decision-activate-next.json
{
  "decision": "activate_next",
  "reason": "All criteria met",
  "next_link": "build"
}

// tests/fixtures/chain-def-auth.json
{
  "chain_id": "chain-test-001",
  "chain_title": "Test Auth Module",
  "tasks": {
    "plan":   { "title": "Plan Auth",  "description": "...", "criteria": "...", "priority": 0 },
    "build":  { "title": "Build Auth", "description": "...", "criteria": "...", "priority": 1 },
    "verify": { "title": "Verify Auth","description": "...", "criteria": "...", "priority": 1 },
    "review": { "title": "Review Auth","description": "...", "criteria": "...", "priority": 1 },
    "accept": { "title": "Accept Auth","description": "...", "criteria": "...", "priority": 2 }
  }
}
```

### 3.2 Instance 标识

测试中使用固定的 instance ID 前缀：
- Leader: `test-leader-0000000001`
- Worker: `test-worker-0000000001` ~ `test-worker-0000000005`

## 4. 核心链路测试覆盖

| 链路 | 测试文档 | Level 1 | Level 2 | Level 3 | Level 4 | Level 5 |
|------|---------|---------|---------|---------|---------|---------|
| 1. 需求→任务 | `tc-01-decompose.md` | ✓ | ✓ | ✓ | ✓ | — |
| 2. 认领→执行 | `tc-02-task-lifecycle.md` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 3. 链推进 | `tc-03-chain-progression.md` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 4. 合并→关闭 | `tc-04-merge.md` | ✓ | ✓ | ✓ | ✓ | ✓ |
| 5. 恢复 | `tc-05-recovery.md` | ✓ | ✓ | ✓ | ✓ | ✓ |

## 5. 运行测试

```bash
# 运行所有测试
npm test

# 运行核心链路测试
npx vitest run tests/core/

# 运行单个链路
npx vitest run tests/core/tc-02-task-lifecycle.test.ts

# 按 level 过滤
npx vitest run --grep "Level 1"
```

## 6. 测试命名规范

```
describe("Core Chain N: <链路名称>", () => {
  describe("Level 1 — 单点", () => {
    it("should <单一操作> → verify: <验证点>");
  });

  describe("Level 2 — 双点对接", () => {
    it("should <操作A> → <操作B> → verify: <验证点>");
  });

  describe("Level 3 — 短链", () => {
    it("should <操作A> → <操作B> → <操作C> → verify: <验证点>");
  });

  describe("Level 4 — 全链", () => {
    it("should <端到端流程> → verify: <最终状态>");
  });

  describe("Level 5 — 异常路径", () => {
    it("should <故障场景> → verify: <恢复状态>");
  });
});
```

每个测试用例格式：

```typescript
it("should <行为描述> → verify: <验证条件>", async () => {
  // 1. Given — 准备初始状态
  // 2. When — 执行被测操作
  // 3. Then — 断言预期结果
});
```
