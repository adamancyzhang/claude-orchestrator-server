#!/usr/bin/env node
import "./child-boot.js";
import { startWorkerChild, type ChildConfig } from "@co/worker";

const raw = process.argv[2];
if (!raw) {
  console.error("Worker child requires JSON config argument");
  process.exit(1);
}
const config = JSON.parse(raw) as ChildConfig;
startWorkerChild(config).catch((err) => {
  console.error("Worker child fatal error:", err);
  process.exit(1);
});
