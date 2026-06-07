Break down the requirement below into a chain of tasks. Each task carries its own system_prompt that tells the Worker exactly how to work. Workers have no fixed roles -- the system_prompt defines their behavior for each specific task.

## Step 0: Restore Directory Memory

Read `{{co_root}}/docs/{{name}}/YYYY-MM-DD/CLAUDE.md` (use today's date) to restore session context. If it doesn't exist, create the directory and seed it with today's date, your name and role. Read your personal CLAUDE.md at `{{co_root}}/docs/{{name}}/CLAUDE.md` for role-specific rules.

## Requirement

{{task_description}}

## Magic Mode Context

- `magic_mode`: **{{magic_mode}}**
- `magic_max_chains`: **{{magic_max_chains}}**

When `magic_mode=true`, the chain runs under `--magic`: every chain MUST include a sixth `explore` task whose Explorer worker decides whether to spawn a follow-up chain (`spawn_chain` with `next_requirement`) or terminate the magic loop (`close_chain`).

When `magic_mode=false`, the chain MUST NOT include an `explore` task.

## Instructions

1. Analyze the requirement. Identify how many independent delivery chains are needed.
2. For each chain, define the tasks in order. Tasks are labeled by their purpose (e.g., "plan", "execute", "verify"), but the labels are suggestions -- you decide what each task should be based on the requirement. Common patterns:
   - Simple task: just an execute task (no plan needed)
   - Standard task: plan -> execute -> verify
   - Full quality: plan -> execute -> verify -> review -> accept
   - Magic mode: any of the above + explore as the final task
3. For each task, generate a **system_prompt** using the structure defined below. This is the most important part -- the system_prompt IS the Worker's instructions. Without it, the Worker has no guidance.
4. For each task, specify objectively verifiable completion criteria -- use concrete commands and expected outputs, not vague descriptions.
5. Assign priority: 0 (urgent), 1 (high), 2 (normal).
6. For Explore (magic mode only): the description should instruct the Explorer to review the full chain results plus the parent chain summary, and decide between `spawn_chain` (carry a concrete `next_requirement`) or `close_chain` (terminate the magic loop).

## System Prompt Structure

Each task's `system_prompt` MUST follow this structure. Every section is required:

```markdown
## 背景
[用户原始需求的上下文。用 1-3 句话说明用户想要什么，为什么要做这件事。]

## 当前任务
[这个任务在整体链路中的位置和目的。说明这是第几个任务，要达成什么目标。]

## 工作方法
[如何完成这个任务。步骤化的、可执行的指导。不要笼统说"完成任务"，要给出具体步骤。]

## 上游产物
[前序任务的输出，供参考。列出依赖的文件路径、配置、代码等。如果是第一个任务，写"无"。]

## 约束
[质量标准、输出格式、注意事项。包括技术约束、风格要求、禁止事项等。]

## 输出
[期望的产出物。明确写出要生成或修改哪些文件，最终应该是什么状态。]
```

### Writing Good System Prompts

**DO:**
- Write step-by-step work methods with specific commands
- Reference concrete file paths and tools
- State what "done" looks like in the Output section
- Include technical constraints (framework version, coding style, etc.)

**DON'T:**
- Use role-based language ("你是一个 Planner", "你是一个 Executor")
- Write vague instructions ("完成任务", "做好这件事")
- Skip sections -- every section must be present
- Write the system_prompt as a task description -- it should be a work methodology

## Output

Write the result to {{result_path}}. Also save a copy to `{{co_root}}/docs/{{name}}/YYYY-MM-DD/chain-def.json`.

```json
{
  "chain_id": "chain-<seq>",
  "chain_title": "<short summary of the overall goal>",
  "tasks": [
    {
      "task_id": "0",
      "title": "<short title>",
      "system_prompt": "<generated system prompt following the 6-section structure>",
      "description": "<one-line task description>",
      "criteria": "<verifiable criteria: concrete commands and expected outputs>",
      "priority": 1,
      "depends_on": []
    },
    {
      "task_id": "1",
      "title": "<short title>",
      "system_prompt": "<generated system prompt>",
      "description": "<one-line task description>",
      "criteria": "<verifiable criteria>",
      "priority": 1,
      "depends_on": ["0"]
    }
  ]
}
```

When `magic_mode=true`, append an explore task as the final entry:

```json
{
  "task_id": "explore",
  "title": "Explore: decide spawn vs close",
  "system_prompt": "## 背景\n[...chain context...]\n\n## 当前任务\nReview the full chain results. Decide whether to continue the magic loop.\n\n## 工作方法\n1. Read all task results from the chain\n2. Read the parent chain summary (if any)\n3. Evaluate: is there a meaningful follow-up task?\n4. If yes: output spawn_chain with next_requirement\n5. If no: output close_chain with rationale\n\n## 上游产物\n- All task results from this chain\n- Parent chain summary (if any)\n\n## 约束\n- Only spawn if the follow-up adds clear user value\n- The next_requirement must be specific and actionable\n- Do not spawn more than magic_max_chains total chains\n\n## 输出\nresult.md containing either spawn_chain{next_requirement:<text>} or close_chain{reason:<text>}",
  "description": "Review full chain context. Output spawn_chain or close_chain.",
  "criteria": "result.md contains either spawn_chain{next_requirement:<non-empty>} or close_chain with a one-line rationale",
  "priority": 1,
  "depends_on": ["<last task id>"]
}
```

Output ONLY the JSON for the active mode. No explanation.

## Example: Create a Vue 3 Project

**User input:** "帮我创建一个 Vue 3 项目，使用 TypeScript 和 Vite"

**Leader decomposes into 3 tasks:**

```json
{
  "chain_id": "chain-1",
  "chain_title": "Create Vue 3 + TypeScript + Vite project",
  "tasks": [
    {
      "task_id": "0",
      "title": "Initialize Vue 3 project",
      "system_prompt": "## 背景\n用户希望创建一个 Vue 3 前端项目，使用 TypeScript 作为开发语言，Vite 作为构建工具。\n\n## 当前任务\n这是第 1 个任务（共 3 个）。目标是初始化项目结构，让项目能跑起来。\n\n## 工作方法\n1. 运行 `npm create vue@latest my-vue-app` 创建项目\n2. 在交互式选项中选择：TypeScript=yes, JSX=no, Vue Router=yes, Pinia=yes, Vitest=yes, ESLint=yes, Prettier=yes\n3. 运行 `cd my-vue-app && npm install` 安装依赖\n4. 运行 `npm run dev` 验证项目能正常启动\n5. 运行 `npm run build` 验证构建能正常完成\n6. 检查目录结构是否合理\n\n## 上游产物\n无\n\n## 约束\n- 使用 Vue 3 Composition API\n- 使用 `<script setup>` 语法\n- TypeScript 严格模式（tsconfig.json 中 strict: true）\n- 不要手动修改 package.json，所有配置通过脚手架生成\n\n## 输出\n一个可运行的 Vue 3 + TypeScript + Vite 项目，位于 my-vue-app/ 目录",
      "description": "Initialize Vue 3 project with Vite and TypeScript",
      "criteria": "npm run dev starts without errors; npm run build completes successfully; src/ directory contains .vue and .ts files",
      "priority": 1,
      "depends_on": []
    },
    {
      "task_id": "1",
      "title": "Configure development environment",
      "system_prompt": "## 背景\n用户希望创建一个 Vue 3 前端项目。前序任务已完成项目初始化。\n\n## 当前任务\n这是第 2 个任务（共 3 个）。目标是配置开发环境，确保代码质量和开发体验。\n\n## 工作方法\n1. 检查现有 ESLint 配置（eslint.config.js），确认 Vue 官方规则已启用\n2. 检查 Prettier 配置（.prettierrc），确认格式化规则合理\n3. 在 vite.config.ts 中配置路径别名 `@` 指向 `src/`\n4. 在 tsconfig.json 中添加对应的路径映射\n5. 运行 `npm run lint` 验证 lint 能正常工作\n6. 运行 `npm run format` 验证格式化能正常工作\n\n## 上游产物\n- 项目根目录：my-vue-app/\n- 已安装的依赖：Vue 3, TypeScript, Vite, Vue Router, Pinia\n- 已有配置：ESLint, Prettier（来自脚手架）\n\n## 约束\n- 使用 ESLint flat config 格式（eslint.config.js）\n- 路径别名 `@` 必须在 vite.config.ts 和 tsconfig.json 中同时配置\n- 保持与 Vue 官方配置一致\n\n## 输出\n配置好的开发环境，`npm run lint` 和 `npm run format` 能正常工作，`@/` 路径别名可用",
      "description": "Configure ESLint, Prettier, and path aliases",
      "criteria": "npm run lint exits 0; npm run format --check exits 0; import from '@/...' resolves correctly",
      "priority": 1,
      "depends_on": ["0"]
    },
    {
      "task_id": "2",
      "title": "Create page structure with routing",
      "system_prompt": "## 背景\n用户希望创建一个 Vue 3 前端项目。项目已初始化，开发环境已配置。\n\n## 当前任务\n这是第 3 个任务（共 3 个，最后一个）。目标是创建基础页面结构，让用户能看到一个可导航的应用。\n\n## 工作方法\n1. 创建 `src/views/HomeView.vue`，包含简单的欢迎信息\n2. 创建 `src/views/AboutView.vue`，包含简单的关于页面内容\n3. 打开 `src/router/index.ts`，添加路由表：\n   - `/` -> HomeView\n   - `/about` -> AboutView\n4. 修改 `src/App.vue`，添加导航栏和 `<router-view>`\n5. 运行 `npm run dev`，在浏览器中验证页面能正常跳转\n6. 运行 `npm run build` 确认构建成功\n\n## 上游产物\n- 项目根目录：my-vue-app/\n- 已配置：ESLint, Prettier, 路径别名 @/\n- 已安装：Vue Router, Pinia\n\n## 约束\n- 使用 Composition API + `<script setup>`\n- 样式使用 scoped CSS\n- 导航使用 `<RouterLink>` 组件\n- 不要引入额外的 UI 框架\n\n## 输出\n包含首页和关于页的可导航应用，`npm run dev` 启动后能在两个页面间切换",
      "description": "Create HomeView, AboutView, and configure Vue Router",
      "criteria": "npm run dev starts; navigating to / shows HomeView; navigating to /about shows AboutView; no console errors",
      "priority": 1,
      "depends_on": ["1"]
    }
  ]
}
```

## Record

After completion, update `{{co_root}}/docs/{{name}}/YYYY-MM-DD/CLAUDE.md` with the chain_id and chain_title.
