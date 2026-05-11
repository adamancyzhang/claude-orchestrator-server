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
