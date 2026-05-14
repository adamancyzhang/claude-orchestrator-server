export type Brand<T, B> = T & { readonly __brand: B };

export type InstanceId = Brand<string, "InstanceId">;
export type TaskId = Brand<string, "TaskId">;
export type MessageId = Brand<string, "MessageId">;
export type ChainId = Brand<string, "ChainId">;
export type SessionId = Brand<string, "SessionId">;
export type WorktreeName = Brand<string, "WorktreeName">;
export type ProjectId = Brand<string, "ProjectId">;
export type ZkPath = Brand<string, "ZkPath">;

export const asInstanceId = (s: string): InstanceId => s as InstanceId;
export const asTaskId = (s: string): TaskId => s as TaskId;
export const asMessageId = (s: string): MessageId => s as MessageId;
export const asChainId = (s: string): ChainId => s as ChainId;
export const asSessionId = (s: string): SessionId => s as SessionId;
export const asWorktreeName = (s: string): WorktreeName => s as WorktreeName;
export const asProjectId = (s: string): ProjectId => s as ProjectId;
export const asZkPath = (s: string): ZkPath => s as ZkPath;
