declare module "node-zookeeper-client" {
  namespace zookeeper {
    interface Client {
      connect(): void;
      close(): void;
      getState(): number;
      once(event: string, cb: () => void): void;
      on(event: string, cb: (...args: unknown[]) => void): void;
      removeListener(event: string, cb: Function): void;
      mkdirp(path: string, cb: (err: Error | null) => void): void;
      create(
        path: string,
        data: Buffer,
        mode: number,
        cb: (err: Error | null, createdPath: string) => void
      ): void;
      getData(
        path: string,
        cb: (err: Error | null, data: Buffer) => void
      ): void;
      getData(
        path: string,
        watcher: () => void,
        cb: (err: Error | null, data: Buffer) => void
      ): void;
      setData(
        path: string,
        data: Buffer,
        cb: (err: Error | null) => void
      ): void;
      getChildren(
        path: string,
        cb: (err: Error | null, children: string[]) => void
      ): void;
      getChildren(
        path: string,
        watcher: () => void,
        cb: (err: Error | null, children: string[]) => void
      ): void;
      remove(path: string, cb: (err: Error | null) => void): void;
      exists(
        path: string,
        cb: (err: Error | null, stat: unknown) => void
      ): void;
    }

    const CreateMode: {
      PERSISTENT: 0;
      PERSISTENT_SEQUENTIAL: 2;
      EPHEMERAL: 1;
      EPHEMERAL_SEQUENTIAL: 3;
    };

    const Exception: {
      OK: 0;
      SYSTEM_ERROR: -1;
      RUNTIME_INCONSISTENCY: -2;
      DATA_INCONSISTENCY: -3;
      CONNECTION_LOSS: -4;
      MARSHALLING_ERROR: -5;
      UNIMPLEMENTED: -6;
      OPERATION_TIMEOUT: -7;
      BAD_ARGUMENTS: -8;
      API_ERROR: -100;
      NO_NODE: -101;
      NO_AUTH: -102;
      BAD_VERSION: -103;
      NO_CHILDREN_FOR_EPHEMERALS: -108;
      NODE_EXISTS: -110;
      NOT_EMPTY: -111;
      SESSION_EXPIRED: -112;
      INVALID_CALLBACK: -113;
      INVALID_ACL: -114;
      AUTH_FAILED: -115;
    };

    const State: {
      DISCONNECTED: number;
      SYNC_CONNECTED: number;
      AUTH_FAILED: number;
      CONNECTED_READ_ONLY: number;
      SASL_AUTHENTICATED: number;
      EXPIRED: number;
    };

    function createClient(
      connectionString: string,
      options?: { sessionTimeout?: number; spinDelay?: number; retries?: number }
    ): Client;
  }

  export = zookeeper;
}
