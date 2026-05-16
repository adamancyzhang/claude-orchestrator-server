import type { InstanceId } from "./ids.js";

export const PROTOCOL_VERSION = "0.6.0" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export interface LeaderNodeData {
  protocol_version: ProtocolVersion;
  leader_id: InstanceId;
  pid: number;
  host: string;
  started_at: string;
}
