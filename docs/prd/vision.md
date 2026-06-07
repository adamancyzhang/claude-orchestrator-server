# Claude Orchestrator — 产品愿景

## 核心理念

**Worker 是完全通用的执行者，能做任何事情。**

系统不预设角色（planner/executor/verifier），不使用固定模板。Leader 根据每个任务的特点，动态生成系统提示词来指导 Worker 如何工作。

```
用户: "帮我创建一个 Vue 项目"
        ↓
Leader: 分析需求 → 拆解任务 → 为每个任务生成系统提示词
        ↓
Worker: 收到 (任务 + 系统提示词) → 自由执行 → 完成报告
        ↓
Leader: 评估结果 → 决定下一步
```

## 设计原则

### 1. Worker 无角色绑定

Worker 没有固定身份。它不是"planner"、"executor"或"verifier"。它是一个通用的 AI 执行者，通过系统提示词获得临时的工作指导。

**错误做法：**
```
system_prompt = "你是一个 Planner，你的职责是..."
```

**正确做法：**
```
system_prompt = Leader 根据任务动态生成的内容
```

### 2. Leader 全权决定工作方式

Leader 是唯一的"大脑"。它：
- 分析用户需求
- 拆解为可执行的子任务
- 为每个子任务生成系统提示词，告诉 Worker 怎么工作
- 决定任务之间的依赖关系
- 评估 Worker 的完成质量

### 3. 系统提示词指导"如何"，而非"做什么"

系统提示词不是任务描述，而是工作方法论。

**错误做法：**
```
"创建一个 Vue 项目，使用 Vite，配置 TypeScript..."
```

**正确做法：**
```
"你正在为用户创建前端项目。
工作方法：
1. 先确认技术栈选择（框架、构建工具、语言）
2. 使用官方脚手架初始化
3. 验证项目能正常运行
4. 整理目录结构
输出：可运行的项目代码"
```

### 4. 任何工作内容都可以

Worker 不应被限制在"写代码"。它可以：
- 写代码
- 写文档
- 做调研
- 设计架构
- 创建配置
- 执行命令
- 分析问题
- 任何 LLM 能做的事情

## 架构变更

### 当前架构（废弃）

```
用户需求 → Leader → ChainDef(plan, execute, verify, review, accept)
                ↓
        固定模板渲染 → Worker(planner) → Worker(executor) → ...
```

### 目标架构

```
用户需求 → Leader 分析
                ↓
        动态生成 ChainDef（任务列表 + 每个任务的系统提示词）
                ↓
        Worker[0] 收到 (任务 + 系统提示词) → 执行 → 完成
                ↓
        Leader 评估 → Worker[1] 收到 (任务 + 系统提示词) → 执行 → 完成
                ↓
        ... 直到所有任务完成
```

## 系统提示词生成规范

### 结构

Leader 为每个任务生成的系统提示词应包含：

```markdown
## 背景
[用户原始需求的上下文]

## 当前任务
[这个任务在整个链路中的位置和目的]

## 工作方法
[如何完成这个任务，步骤化的指导]

## 上游产物
[前序任务的输出，供参考]

## 约束
[质量标准、输出格式、注意事项]

## 输出
[期望的产出物]
```

### 示例：创建 Vue 项目

**用户输入：** "帮我创建一个 Vue 3 项目，使用 TypeScript 和 Vite"

**Leader 拆解为 3 个任务：**

**任务 0 系统提示词：**
```markdown
## 背景
用户希望创建一个 Vue 3 前端项目，使用 TypeScript 作为开发语言，Vite 作为构建工具。

## 当前任务
初始化项目结构。使用官方脚手架创建项目，配置 TypeScript。

## 工作方法
1. 使用 `npm create vue@latest` 创建项目（选择 TypeScript、Router、Pinia）
2. 安装依赖 `npm install`
3. 验证项目能正常启动 `npm run dev`
4. 检查目录结构是否合理

## 约束
- 使用 Vue 3 Composition API
- 使用 `<script setup>` 语法
- 确保 TypeScript 严格模式

## 输出
可运行的 Vue 3 + TypeScript + Vite 项目
```

**任务 1 系统提示词：**
```markdown
## 背景
用户希望创建一个 Vue 3 前端项目。前序任务已完成项目初始化。

## 当前任务
配置开发环境。添加 ESLint、Prettier，配置路径别名。

## 上游产物
- 项目根目录：[path]
- 已安装的依赖：Vue 3, TypeScript, Vite, Vue Router, Pinia

## 工作方法
1. 安装 ESLint + Vue 官方配置
2. 安装 Prettier 并配置与 ESLint 集成
3. 配置 vite.config.ts 的路径别名（@/ -> src/）
4. 验证 lint 能正常运行 `npm run lint`

## 约束
- 使用 flat config 格式（eslint.config.js）
- 保持与 Vue 官方配置一致

## 输出
配置好的开发环境，lint 和 format 能正常工作
```

**任务 2 系统提示词：**
```markdown
## 背景
用户希望创建一个 Vue 3 前端项目。项目已初始化，开发环境已配置。

## 当前任务
创建基础页面结构。添加首页、关于页，配置路由。

## 上游产物
- 项目根目录：[path]
- 已配置：ESLint, Prettier, 路径别名

## 工作方法
1. 创建 src/views/HomeView.vue 和 src/views/AboutView.vue
2. 配置 Vue Router 路由表
3. 修改 App.vue 添加 router-view
4. 添加基础样式
5. 验证页面能正常跳转

## 约束
- 使用 Composition API + `<script setup>`
- 样式使用 scoped CSS

## 输出
包含首页和关于页的可导航应用
```

## ChainDef 格式变更

### 当前格式（废弃）

```json
{
  "chain_id": "xxx",
  "links": [
    { "link": "plan", "title": "...", "description": "...", "criteria": "..." },
    { "link": "execute", "title": "...", "description": "...", "criteria": "..." },
    { "link": "verify", "title": "...", "description": "...", "criteria": "..." }
  ]
}
```

### 目标格式

```json
{
  "chain_id": "xxx",
  "tasks": [
    {
      "task_id": "0",
      "title": "初始化 Vue 项目",
      "system_prompt": "## 背景\n用户希望创建...",
      "depends_on": []
    },
    {
      "task_id": "1",
      "title": "配置开发环境",
      "system_prompt": "## 背景\n前序任务已完成...",
      "depends_on": ["0"]
    },
    {
      "task_id": "2",
      "title": "创建基础页面",
      "system_prompt": "## 背景\n项目已初始化...",
      "depends_on": ["1"]
    }
  ]
}
```

## Worker 行为规范

### Worker 收到任务后：

1. 读取系统提示词
2. 读取上游产物（如有）
3. 按系统提示词的指导执行
4. 将结果写入指定位置
5. 提交代码
6. 自评估完成质量
7. 发送完成报告

### Worker 自评估标准：

```json
{
  "status": "completed" | "needs_revision" | "failed",
  "summary": "完成情况总结",
  "output_path": "产物路径",
  "commit_hash": "提交哈希"
}
```

## 实施路线

### Phase 1: 核心重构
- [ ] 修改 ChainDef 格式，支持自定义 system_prompt
- [ ] Leader decompose 模板改为生成 system_prompt
- [ ] Worker 移除固定角色模板，使用 Leader 提供的 system_prompt
- [ ] 保留链式依赖和上游产物传递

### Phase 2: 增强 Leader
- [ ] 提升 Leader 的任务拆解能力
- [ ] Leader 能根据任务特点动态决定工作方法
- [ ] Leader 能评估 Worker 产出质量并给出反馈

### Phase 3: 泛化能力
- [ ] 支持非代码任务（文档、调研、设计等）
- [ ] 支持更复杂的依赖图（DAG，而非线性链）
- [ ] 支持并行执行无依赖的任务
