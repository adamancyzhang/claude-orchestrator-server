#!/usr/bin/env node
import { startWorkerChild, type ChildConfig } from "./child-runner.js";

const config: ChildConfig = JSON.parse(process.argv[2]);
startWorkerChild(config).catch((err) => {
  console.error("Worker child fatal error:", err);
  process.exit(1);
});
