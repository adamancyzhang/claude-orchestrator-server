import { z } from "zod";

// ── Enums ──

export const InstanceStatus = z.enum(["idle", "busy"]);
export type InstanceStatus = z.infer<typeof InstanceStatus>;

export const InstanceRole = z.enum(["architect", "developer", "tester", "general", "leader"]);
export type InstanceRole = z.infer<typeof InstanceRole>;

export const TaskStatus = z.enum(["pending", "claimed", "in_progress", "completed", "blocked", "failed"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.number().int().min(0).max(2);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const TaskPriorityName: Record<number, string> = {
  0: "HIGH",
  1: "MEDIUM",
  2: "LOW",
};

export const MessageType = z.enum(["direct", "broadcast"]);
export type MessageType = z.infer<typeof MessageType>;

// ── Data Models ──

function utcNow(): string {
  return new Date().toISOString();
}

export const InstanceSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: InstanceRole.default("general"),
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
  retry_count: z.number().int().default(0),
  blocked_reason: z.string().nullable().default(null),
  fail_reason: z.string().nullable().default(null),
  created_by_name: z.string().default(""),
  assigned_to_name: z.string().nullable().default(null),
  completed_by_name: z.string().nullable().default(null),
  duration_seconds: z.number().nullable().default(null),
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
    role: overrides.role ?? "general",
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
    retry_count: 0,
    blocked_reason: null,
    fail_reason: null,
    created_by_name: overrides.created_by_name ?? "",
    assigned_to_name: overrides.assigned_to_name ?? null,
    completed_by_name: null,
    duration_seconds: null,
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
