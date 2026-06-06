#!/usr/bin/env node
import { startWorkerChild, type ChildConfig } from "./child-runner.js";

const raw = process.argv[2];
if (!raw) {
  console.error("Worker child requires JSON config argument");
  process.exit(1);
}
let config: ChildConfig;
try {
  config = JSON.parse(raw) as ChildConfig;
} catch (err) {
  console.error(
    `Worker child: failed to parse JSON config: ${err instanceof Error ? err.message : String(err)}`,
  );
  console.error("Received:", raw.slice(0, 200));
  process.exit(1);
}
startWorkerChild(config).catch((err) => {
  console.error("Worker child fatal error:", err);
  process.exit(1);
});
