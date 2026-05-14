import {
  asZkPath,
  type InstanceId,
  type MessageId,
  type ProjectId,
  type TaskId,
  type ZkPath,
} from "../ids.js";

export interface ZkPathOptions {
  project_id?: ProjectId;
}

export const DEFAULT_ROOT: ZkPath = asZkPath("/claude-orchestrator");

export function projectRoot(opts?: ZkPathOptions): ZkPath {
  return opts?.project_id
    ? asZkPath(`/co/${opts.project_id}`)
    : DEFAULT_ROOT;
}

export const leader = (o?: ZkPathOptions): ZkPath =>
  asZkPath(`${projectRoot(o)}/leader`);
export const instances = (o?: ZkPathOptions): ZkPath =>
  asZkPath(`${projectRoot(o)}/instances`);
export const instance = (id: InstanceId, o?: ZkPathOptions): ZkPath =>
  asZkPath(`${instances(o)}/${id}`);
export const tasksRoot = (o?: ZkPathOptions): ZkPath =>
  asZkPath(`${projectRoot(o)}/tasks`);
export const tasksPending = (o?: ZkPathOptions): ZkPath =>
  asZkPath(`${tasksRoot(o)}/pending`);
export const tasksClaimed = (o?: ZkPathOptions): ZkPath =>
  asZkPath(`${tasksRoot(o)}/claimed`);
export const tasksCompleted = (o?: ZkPathOptions): ZkPath =>
  asZkPath(`${tasksRoot(o)}/completed`);
export const taskPending = (taskId: TaskId, o?: ZkPathOptions): ZkPath =>
  asZkPath(`${tasksPending(o)}/${taskId}`);
export const taskClaimed = (
  insId: InstanceId,
  taskId: TaskId,
  o?: ZkPathOptions,
): ZkPath => asZkPath(`${tasksClaimed(o)}/${insId}-${taskId}`);
export const taskCompleted = (taskId: TaskId, o?: ZkPathOptions): ZkPath =>
  asZkPath(`${tasksCompleted(o)}/${taskId}`);
export const messages = (o?: ZkPathOptions): ZkPath =>
  asZkPath(`${projectRoot(o)}/messages`);
export const messageDir = (insId: InstanceId, o?: ZkPathOptions): ZkPath =>
  asZkPath(`${messages(o)}/${insId}`);
export const message = (
  insId: InstanceId,
  msgId: MessageId,
  o?: ZkPathOptions,
): ZkPath => asZkPath(`${messageDir(insId, o)}/${msgId}`);

export function allEnsurePaths(o?: ZkPathOptions): readonly ZkPath[] {
  return [
    projectRoot(o),
    instances(o),
    tasksRoot(o),
    tasksPending(o),
    tasksClaimed(o),
    tasksCompleted(o),
    messages(o),
  ];
}
