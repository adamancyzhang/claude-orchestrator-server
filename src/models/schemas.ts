import { z } from "zod";

// ── Enums ──

export const InstanceStatus = z.enum(["idle", "busy", "blocked"]);
export type InstanceStatus = z.infer<typeof InstanceStatus>;

export const InstanceRole = z.enum(["architect", "developer", "tester", "general"]);
export type InstanceRole = z.infer<typeof InstanceRole>;

export const TaskStatus = z.enum(["pending", "claimed", "completed"]);
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
  role: InstanceRole.default("general"),
  status: InstanceStatus.default("idle"),
  current_task_id: z.string().nullable().default(null),
  connected_since: z.string(),
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
});
export type Task = z.infer<typeof TaskSchema>;

export const MessageSchema = z.object({
  id: z.string().default(""),
  type: MessageType.default("direct"),
  from_instance: z.string().default(""),
  from_name: z.string().default(""),
  to_instance: z.string().nullable().default(null),
  content: z.string(),
  created_at: z.string(),
  read: z.boolean().default(false),
});
export type Message = z.infer<typeof MessageSchema>;

export const ContextEntrySchema = z.object({
  key: z.string(),
  value: z.string(),
  updated_by: z.string().default(""),
  updated_at: z.string(),
});
export type ContextEntry = z.infer<typeof ContextEntrySchema>;

// ── Factory helpers (mirrors Python Field(default_factory=...)) ──

export function createInstance(overrides: {
  id?: string;
  name: string;
  role?: InstanceRole;
}): Instance {
  return InstanceSchema.parse({
    id: overrides.id ?? crypto.randomUUID().replace(/-/g, ""),
    name: overrides.name,
    role: overrides.role ?? "general",
    status: "idle",
    current_task_id: null,
    connected_since: utcNow(),
  });
}

export function createTask(overrides: {
  title: string;
  description?: string;
  priority?: number;
  created_by?: string;
  assigned_to?: string | null;
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
  });
}

export function createMessage(overrides: {
  type?: MessageType;
  from_instance: string;
  from_name: string;
  to_instance: string;
  content: string;
}): Message {
  return MessageSchema.parse({
    id: "",
    type: overrides.type ?? "direct",
    from_instance: overrides.from_instance,
    from_name: overrides.from_name,
    to_instance: overrides.to_instance,
    content: overrides.content,
    created_at: utcNow(),
    read: false,
  });
}

export function createContextEntry(overrides: {
  key: string;
  value: string;
  updated_by?: string;
}): ContextEntry {
  return ContextEntrySchema.parse({
    key: overrides.key,
    value: overrides.value,
    updated_by: overrides.updated_by ?? "",
    updated_at: utcNow(),
  });
}

// ── Tool input schemas ──

export const RegisterInstanceInput = z.object({
  name: z.string().min(1),
  role: InstanceRole.default("general"),
  instance_id: z.string().optional(),
});

export const HeartbeatInput = z.object({
  instance_id: z.string(),
  current_task: z.string().optional(),
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
  broadcast: z.boolean().default(false),
});

export const PollMessagesInput = z.object({
  instance_id: z.string(),
});

export const WaitForMessageInput = z.object({
  instance_id: z.string(),
  timeout_seconds: z.number().int().min(1).default(30),
});

export const MarkReadInput = z.object({
  instance_id: z.string(),
  message_id: z.string(),
});

export const DismissMessageInput = z.object({
  instance_id: z.string(),
  message_id: z.string(),
});

export const RequestHelpInput = z.object({
  instance_id: z.string(),
  question: z.string().min(1),
  context: z.string().optional(),
});

export const SetContextInput = z.object({
  key: z.string().min(1),
  value: z.string(),
  instance_id: z.string().default(""),
});

export const GetContextInput = z.object({
  key: z.string(),
});

export const DeleteContextInput = z.object({
  key: z.string(),
});
