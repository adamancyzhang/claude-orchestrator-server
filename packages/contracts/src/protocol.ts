import type { InstanceId } from "./ids.js";

export const PROTOCOL_VERSION = "0.7.0" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export interface LeaderNodeData {
  protocol_version: ProtocolVersion;
  leader_id: InstanceId;
  pid: number;
  host: string;
  started_at: string;
  magic_mode: boolean;
  magic_max_chains: number | null;
}
