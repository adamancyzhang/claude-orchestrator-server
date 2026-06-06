export { ZkClient, type ZkClientOptions } from "./zk/client.js";
export { InMemoryZkClient, type ZkTreeNode } from "./zk/in-memory-client.js";
export { Logger, type LoggerOptions, type LogFormat } from "./logger.js";
export {
  Counter,
  LabeledCounter,
  Gauge,
  Histogram,
  PrometheusMetricsCollector,
  MetricsCollector,
  type AlertRule,
  type MetricsCollectorOptions,
} from "./metrics.js";
export {
  execWithStreaming,
  execAndCapture,
  type ExecStreamingOptions,
  type ExecStreamingResult,
  type ExecCaptureResult,
} from "./utils/exec.js";
export { output } from "./utils/output.js";
export {
  captureConsoleToFile,
  restoreConsole,
} from "./utils/console-capture.js";
export {
  readJson,
  writeJsonAtomic,
  ensureDir,
} from "./utils/fs-json.js";
export {
  loadConfig,
  saveInstanceId,
  saveInitStatus,
  loadInitStatus,
  saveProjectInitStatus,
  loadProjectInitStatus,
  loadProjectWorktreeConfig,
  saveProjectWorktreeConfig,
  type WorktreeEntry,
  type LoadConfigInput,
} from "./config/config-loader.js";
