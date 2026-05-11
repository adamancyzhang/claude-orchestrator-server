export const ROOT = "/claude-orchestrator";

export const INSTANCES = `${ROOT}/instances`;
export const TASKS = `${ROOT}/tasks`;
export const TASKS_PENDING = `${TASKS}/pending`;
export const TASKS_CLAIMED = `${TASKS}/claimed`;
export const TASKS_COMPLETED = `${TASKS}/completed`;
export const MESSAGES = `${ROOT}/messages`;
export const CONTEXT = `${ROOT}/context`;

export function instancePath(instanceId: string): string {
  return `${INSTANCES}/${instanceId}`;
}

export function pendingTaskPath(taskId: string): string {
  return `${TASKS_PENDING}/${taskId}`;
}

export function claimedTaskPath(instanceId: string, taskId: string): string {
  return `${TASKS_CLAIMED}/${instanceId}-${taskId}`;
}

export function completedTaskPath(taskId: string): string {
  return `${TASKS_COMPLETED}/${taskId}`;
}

export function messageDirPath(instanceId: string): string {
  return `${MESSAGES}/${instanceId}`;
}

export function messagePath(instanceId: string, msgId: string): string {
  return `${MESSAGES}/${instanceId}/${msgId}`;
}

export function contextPath(key: string): string {
  return `${CONTEXT}/${key}`;
}

export const ALL_ENSURE_PATHS = [
  ROOT,
  INSTANCES,
  TASKS,
  TASKS_PENDING,
  TASKS_CLAIMED,
  TASKS_COMPLETED,
  MESSAGES,
  CONTEXT,
];
