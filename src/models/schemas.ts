import { z } from "zod";

// ── Enums ──

export const InstanceStatus = z.enum(["idle", "busy"]);
export type InstanceStatus = z.infer<typeof InstanceStatus>;

export const InstanceRole = z.enum(["planner", "builder", "verifier", "reviewer", "accepter", "leader"]);
export type InstanceRole = z.infer<typeof InstanceRole>;

export const TaskLink = z.enum(["plan", "build", "verify", "review", "accept"]);
export type TaskLink = z.infer<typeof TaskLink>;

export const TaskStatus = z.enum(["pending", "claimed", "completed", "blocked", "failed"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.number().int().min(0).max(2);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const TaskPriorityName: Record<number, string> = {
  0: "HIGH",
  1: "MEDIUM",
  2: "LOW",
};

export const MessageType = z.enum(["direct", "broadcast", "help"]);
export type MessageType = z.infer<typeof MessageType>;

// ── Data Models ──

function utcNow(): string {
  return new Date().toISOString();
}

export const InstanceSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: InstanceRole.default("builder"),
  status: InstanceStatus.default("idle"),
  current_task_id: z.string().nullable().default(null),
  connected_since: z.string(),
  work_dir: z.string().nullable().default(null),
});
export type Instance = z.infer<typeof InstanceSchema>;

export const TaskSchema = z.object({
  id: z.string().default(""),
  title: z.string(),
  description: z.string().default(""),
  priority: TaskPriority.default(1),
  status: TaskStatus.default("pending"),
  created_by: z.string().default(""),
  assigned_to: z.string().nullable().default(null),
  created_at: z.string(),
  claimed_at: z.string().nullable().default(null),
  completed_at: z.string().nullable().default(null),
  claimed_by: z.string().nullable().default(null),
  result: z.string().nullable().default(null),
  link: TaskLink.nullable().default(null),
  chain_id: z.string().nullable().default(null),
  retry_count: z.number().int().default(0),
  blocked_reason: z.string().nullable().default(null),
  fail_reason: z.string().nullable().default(null),
  created_by_name: z.string().default(""),
  assigned_to_name: z.string().nullable().default(null),
  completed_by_name: z.string().nullable().default(null),
  duration_seconds: z.number().nullable().default(null),
  depends_on: z.array(z.string()).default([]),
  blocked_by: z.array(z.string()).default([]),
});
export type Task = z.infer<typeof TaskSchema>;

export const MessageSchema = z.object({
  id: z.string().default(""),
  type: MessageType.default("direct"),
  from_instance: z.string().default(""),
  from_name: z.string().default(""),
  from_role: z.string().default(""),
  to_instance: z.string().nullable().default(null),
  to_name: z.string().nullable().default(null),
  content: z.string(),
  created_at: z.string(),
  read: z.boolean().default(false),
  link: z.string().nullable().default(null),
  task_title: z.string().nullable().default(null),
  task_description: z.string().nullable().default(null),
  task_criteria: z.string().nullable().default(null),
  task_doc_path: z.string().nullable().default(null),
  result_path: z.string().nullable().default(null),
  reply_to: z.string().nullable().default(null),
});
export type Message = z.infer<typeof MessageSchema>;

// ── Factory helpers (mirrors Python Field(default_factory=...)) ──

export function createInstance(overrides: {
  id?: string;
  name: string;
  role?: InstanceRole;
  workDir?: string;
}): Instance {
  return InstanceSchema.parse({
    id: overrides.id ?? crypto.randomUUID().replace(/-/g, ""),
    name: overrides.name,
    role: overrides.role ?? "builder",
    status: "idle",
    current_task_id: null,
    connected_since: utcNow(),
    work_dir: overrides.workDir ?? null,
  });
}

export function createTask(overrides: {
  title: string;
  description?: string;
  priority?: number;
  created_by?: string;
  assigned_to?: string | null;
  created_by_name?: string;
  assigned_to_name?: string | null;
  link?: string | null;
  chain_id?: string | null;
  depends_on?: string[];
  blocked_by?: string[];
}): Task {
  return TaskSchema.parse({
    id: "",
    title: overrides.title,
    description: overrides.description ?? "",
    priority: overrides.priority ?? 1,
    status: "pending",
    created_by: overrides.created_by ?? "",
    assigned_to: overrides.assigned_to ?? null,
    created_at: utcNow(),
    claimed_at: null,
    completed_at: null,
    claimed_by: null,
    result: null,
    link: overrides.link ?? null,
    chain_id: overrides.chain_id ?? null,
    retry_count: 0,
    blocked_reason: null,
    fail_reason: null,
    created_by_name: overrides.created_by_name ?? "",
    assigned_to_name: overrides.assigned_to_name ?? null,
    completed_by_name: null,
    duration_seconds: null,
    depends_on: overrides.depends_on ?? [],
    blocked_by: overrides.blocked_by ?? [],
  });
}

export function createMessage(overrides: {
  type?: MessageType;
  from_instance: string;
  from_name: string;
  from_role?: string;
  to_instance: string;
  to_name?: string | null;
  content: string;
  task_doc_path?: string | null;
  result_path?: string | null;
  reply_to?: string | null;
  task_title?: string | null;
  task_description?: string | null;
  task_criteria?: string | null;
  link?: string | null;
}): Message {
  return MessageSchema.parse({
    id: "",
    type: overrides.type ?? "direct",
    from_instance: overrides.from_instance,
    from_name: overrides.from_name,
    from_role: overrides.from_role ?? "",
    to_instance: overrides.to_instance,
    to_name: overrides.to_name ?? null,
    content: overrides.content,
    created_at: utcNow(),
    read: false,
    link: overrides.link ?? null,
    task_title: overrides.task_title ?? null,
    task_description: overrides.task_description ?? null,
    task_criteria: overrides.task_criteria ?? null,
    task_doc_path: overrides.task_doc_path ?? null,
    result_path: overrides.result_path ?? null,
    reply_to: overrides.reply_to ?? null,
  });
}

// ── Tool input schemas ──

export const RegisterInstanceInput = z.object({
  name: z.string().min(1),
  role: InstanceRole,
  instance_id: z.string().optional(),
});

export const PushTaskInput = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  priority: TaskPriority.default(1),
  instance_id: z.string().default(""),
  assignee: z.string().optional(),
  link: z.string().optional(),
  chain_id: z.string().optional(),
  depends_on: z.array(z.string()).default([]),
  blocked_by: z.array(z.string()).default([]),
});

export const ClaimTaskInput = z.object({
  instance_id: z.string(),
});

export const CompleteTaskInput = z.object({
  instance_id: z.string(),
  task_id: z.string(),
  result: z.string(),
});

export const ListTasksInput = z.object({
  status: z.string().optional(),
});

export const SendMessageInput = z.object({
  instance_id: z.string(),
  content: z.string().min(1),
  to_instance: z.string().optional(),
  to_name: z.string().optional(),
  broadcast: z.boolean().default(false),
  help: z.boolean().default(false),
});

export const PollMessagesInput = z.object({
  instance_id: z.string(),
});

export const MarkReadInput = z.object({
  instance_id: z.string(),
  message_id: z.string(),
});

export const DismissMessageInput = z.object({
  instance_id: z.string(),
  message_id: z.string(),
});

// ── Chain & Evaluation Schemas ──

export const ChainTaskDefSchema = z.object({
  title: z.string(),
  description: z.string(),
  criteria: z.string(),
  priority: z.number().int().min(0).max(3),
});
export type ChainTaskDef = z.infer<typeof ChainTaskDefSchema>;

export const ChainDefSchema = z.object({
  chain_id: z.string(),
  chain_title: z.string(),
  tasks: z.object({
    plan: ChainTaskDefSchema.nullable(),
    build: ChainTaskDefSchema,
    verify: ChainTaskDefSchema,
    review: ChainTaskDefSchema,
    accept: ChainTaskDefSchema,
  }),
});
export type ChainDef = z.infer<typeof ChainDefSchema>;

export const EvalDecisionSchema = z.object({
  decision: z.enum(["activate_next", "feedback", "close_chain"]),
  reason: z.string(),
  feedback: z.string().optional(),
  nextLink: z.string().optional(),
  suggestedWorker: z.string().nullable().optional(),
});
export type EvalDecision = z.infer<typeof EvalDecisionSchema>;
