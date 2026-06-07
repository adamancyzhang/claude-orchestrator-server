# 测试流程文档

## 测试流程

### Phase 1: 环境准备

```bash
# 1. 进入测试目录
cd /mnt/c/Users/adama/Documents/projects/test

# 2. 初始化 git 仓库
git init

# 3. 创建基础项目结构
# - package.json（Node.js TODO 项目）
# - src/index.js（Express 服务器）
# - README.md（项目说明）

# 4. 提交所有文件
git add -A && git commit -m "feat: initialize basic TODO app structure"
```

**验证**: git status 显示工作区干净。

### Phase 2: 启动 Orchestrator

```bash
# 首次运行（崩溃）
npx claude-orchestrator run --headless -y
# 输出: Error: ENOENT: commands.jsonl

# 修复 Bug 后
cd /mnt/c/Users/adama/Documents/projects/claude-orchestrator-server
git add packages/leader/src/command-watcher.ts
git commit -m "fix(leader): handle missing commands.jsonl"

# 重新运行
cd /mnt/c/Users/adama/Documents/projects/test
npx claude-orchestrator run --headless -y
```

**观察结果**:
- 4 步初始化完成
- 6 个 worktree 创建
- 6 个 worker 注册成功
- 状态: idle（等待任务输入）

### Phase 3: 生成 ChainDef

按照 decompose.md 模板，为 "创建一个简单的 TODO 应用" 生成 ChainDef JSON：

```json
{
  "chain_id": "chain-1",
  "chain_title": "Create simple TODO application",
  "tasks": [
    {
      "task_id": "0",
      "title": "Initialize project structure",
      "system_prompt": "## 背景\n...\n## 当前任务\n...\n## 工作方法\n...\n## 上游产物\n无\n## 约束\n...\n## 输出\n...",
      "quality_gate": { "type": "self_eval", "command": "...", "expected": "..." },
      "depends_on": []
    },
    {
      "task_id": "1",
      "title": "Create todo model and service",
      "system_prompt": "...",
      "quality_gate": { "type": "test", "command": "node -e \"...\"", "expected": "..." },
      "depends_on": ["0"]
    },
    {
      "task_id": "2",
      "title": "Update routes to use service layer",
      "system_prompt": "...",
      "quality_gate": { "type": "test", "command": "node src/index.js & ...", "expected": "..." },
      "depends_on": ["1"]
    }
  ]
}
```

### Phase 4: 模拟 Worker 执行

#### Task 0: 初始化项目结构
- 创建 `src/todos/` 目录
- 创建 `src/routes/` 目录
- 验证目录存在

**质量门** (self_eval): 目录存在即可通过。

#### Task 1: 创建模型和服务
- 创建 `src/todos/todo.model.js`（Todo 类）
- 创建 `src/todos/todo.service.js`（CRUD 操作）
- 验证：`node -e "const s = require('./src/todos/todo.service'); console.log(s.getAll());"`

**质量门** (test): 命令执行成功，输出 Todo 数组。

#### Task 2: 重构路由
- 创建 `src/routes/todos.js`
- 修改 `src/index.js` 使用新路由
- 启动服务器并测试 API

**质量门** (test): `curl http://localhost:3000/api/todos` 返回 JSON 数组。

### Phase 5: 记录结果

- 测试报告: test-report.md
- 问题清单: issues.md
- 优化建议: recommendations.md

---

## 关键观察

1. **Orchestrator 启动流程**: init -> 创建 worktree -> 启动 worker -> 注册到 state.json
2. **Worker 角色**: planner, executor, verifier, reviewer, accepter（预设角色）
3. **状态管理**: 所有状态存储在 `~/.claude-orchestrator/projects/<id>/state.json`
4. **headless 模式**: 适合自动化测试，状态写入文件而非 TUI
