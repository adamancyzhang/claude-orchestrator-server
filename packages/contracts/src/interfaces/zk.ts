import type { ZkPath } from "../ids.js";

export interface ZkStat {
  version: number;
  ctime: number;
  mtime: number;
}

export type ZkConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "expired";

export interface IZkClient {
  connect(): Promise<void>;
  close(): Promise<void>;

  exists(path: ZkPath): Promise<boolean>;
  createPersistent(path: ZkPath, data: Buffer): Promise<ZkPath>;
  createPersistentSequential(
    parent: ZkPath,
    prefix: string,
    data: Buffer,
  ): Promise<ZkPath>;
  createEphemeral(path: ZkPath, data: Buffer): Promise<ZkPath>;
  createEphemeralSequential(
    parent: ZkPath,
    prefix: string,
    data: Buffer,
  ): Promise<ZkPath>;
  setData(
    path: ZkPath,
    data: Buffer,
    expectedVersion?: number,
  ): Promise<ZkStat>;
  getData(path: ZkPath): Promise<{ data: Buffer; stat: ZkStat } | null>;
  getChildren(path: ZkPath): Promise<string[]>;
  watchChildren(
    path: ZkPath,
    cb: (children: string[]) => void,
  ): Promise<string[]>;
  watchData(
    path: ZkPath,
    cb: (data: Buffer | null) => void,
  ): Promise<Buffer | null>;
  delete(path: ZkPath, expectedVersion?: number): Promise<void>;
  mkdirp(path: ZkPath): Promise<void>;

  readonly state: ZkConnectionState;
  on(
    event: "expired" | "disconnected" | "reconnected",
    cb: () => void,
  ): void;
}
