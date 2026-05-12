import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export async function execWithTee(
  command: string,
  message: string,
  logPath: string,
  cwd?: string,
): Promise<{ code: number }> {
  await fs.promises.mkdir(path.dirname(logPath), { recursive: true });

  const escapedMsg = message.replace(/'/g, "'\\''");
  const shellCmd = `exec ${command} -p '${escapedMsg}' | tee -a '${logPath}'`;

  const msgPreview = message.length > 100 ? message.slice(0, 100) + "..." : message;
  console.log(`\n[Exec] ${command} -p '${msgPreview}' | tee -a '${logPath}'`);

  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", shellCmd], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    child.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
    child.on("exit", (code) => resolve({ code: code ?? -1 }));
    child.on("error", () => resolve({ code: -1 }));
  });
}

export async function execAndCapture(
  command: string,
  message: string,
  logPath: string,
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  await fs.promises.mkdir(path.dirname(logPath), { recursive: true });

  const escapedMsg = message.replace(/'/g, "'\\''");
  const shellCmd = `exec ${command} -p '${escapedMsg}' | tee -a '${logPath}'`;

  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", shellCmd], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "", stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      process.stdout.write(s);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}
