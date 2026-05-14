import {
  createInstance,
  createTask,
  createMessage,
  type Instance,
  type Task,
  type Message,
  type InstanceRole,
} from "../../src/models/schemas.js";

export function makeInstance(overrides: Partial<{
  id: string;
  name: string;
  role: InstanceRole;
  workDir: string;
}> = {}): Instance {
  // No dashes in id — the leader/orchestrator splits claimed-task names at the
  // first "-" to separate instance from task id, so test ids must be dash-free.
  return createInstance({
    id: overrides.id ?? "inst" + Math.random().toString(36).slice(2, 10),
    name: overrides.name ?? "TestWorker",
    role: overrides.role ?? "builder",
    workDir: overrides.workDir,
  });
}

export function makeTask(overrides: Partial<{
  title: string;
  description: string;
  priority: number;
  link: string | null;
  chain_id: string | null;
  created_by: string;
  created_by_name: string;
  assigned_to: string | null;
  assigned_to_name: string | null;
  retry_count: number;
}> = {}): Task {
  const task = createTask({
    title: overrides.title ?? "Test task",
    description: overrides.description ?? "",
    priority: overrides.priority ?? 1,
    link: overrides.link ?? null,
    chain_id: overrides.chain_id ?? null,
    created_by: overrides.created_by ?? "leader-1",
    created_by_name: overrides.created_by_name ?? "Leader",
    assigned_to: overrides.assigned_to ?? null,
    assigned_to_name: overrides.assigned_to_name ?? null,
  });
  if (overrides.retry_count !== undefined) {
    task.retry_count = overrides.retry_count;
  }
  return task;
}

export function makeMessage(overrides: Partial<{
  from_instance: string;
  from_name: string;
  from_role: string;
  to_instance: string;
  content: string;
  link: string | null;
  chain_id: string | null;
  task_title: string;
  task_description: string;
  task_criteria: string;
  reply_to: string;
}> = {}): Message {
  const msg = createMessage({
    from_instance: overrides.from_instance ?? "leader-1",
    from_name: overrides.from_name ?? "Leader",
    from_role: overrides.from_role ?? "leader",
    to_instance: overrides.to_instance ?? "worker-1",
    content: overrides.content ?? "test message",
    link: overrides.link ?? null,
    task_title: overrides.task_title,
    task_description: overrides.task_description,
    task_criteria: overrides.task_criteria,
    reply_to: overrides.reply_to,
  });
  if (overrides.chain_id !== undefined) {
    msg.chain_id = overrides.chain_id;
  }
  return msg;
}

export function makeChainDef(overrides: Partial<{
  chain_id: string;
  chain_title: string;
  hasPlan: boolean;
}> = {}): unknown {
  const baseTask = { title: "t", description: "d", criteria: "c", priority: 1 };
  return {
    chain_id: overrides.chain_id ?? "chain-1",
    chain_title: overrides.chain_title ?? "Test chain",
    tasks: {
      plan: overrides.hasPlan === false ? null : { ...baseTask, title: "Plan it" },
      build: { ...baseTask, title: "Build it" },
      verify: { ...baseTask, title: "Verify it" },
      review: { ...baseTask, title: "Review it" },
      accept: { ...baseTask, title: "Accept it" },
    },
  };
}

export function makeEvalDecision(overrides: Partial<{
  decision: "activate_next" | "feedback" | "close_chain";
  reason: string;
  feedback: string;
  nextLink: string;
}> = {}): unknown {
  return {
    decision: overrides.decision ?? "activate_next",
    reason: overrides.reason ?? "ok",
    feedback: overrides.feedback,
    nextLink: overrides.nextLink,
  };
}
