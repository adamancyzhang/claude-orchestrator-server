import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function extractSessionId(line: string): string | null {
  if (line.startsWith("{")) {
    const obj = JSON.parse(line);
    return obj.session_id || null;
  }
  return null;
}

function escapeShell(s: string): string {
  return s.replace(/'/g, "'\\''");
}

export async function execWithStreaming(
  command: string,
  message: string,
  logPath: string,
  systemPrompt?: string,
  onChunk?: (line: string) => void,
  cwd?: string,
  quiet?: boolean,
): Promise<{ code: number; sessionId?: string }> {
  await fs.promises.mkdir(path.dirname(logPath), { recursive: true });

  const escapedMsg = escapeShell(message);

  let flags = `--output-format stream-json --verbose`;
  if (systemPrompt) {
    flags += ` --append-system-prompt '${escapeShell(systemPrompt)}'`;
  }

  const shellCmd = `exec ${command} ${flags} -p '${escapedMsg}' | tee -a '${escapeShell(logPath)}'`;

  if (!quiet) {
    const msgPreview = message.length > 100 ? message.slice(0, 100) + "..." : message;
    console.log(`\n[Exec] ${command} -p '${msgPreview}' | tee -a '${logPath}'`);
  }

  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", shellCmd], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let partial = "";
    let sessionId: string | undefined;

    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString();
      if (!quiet) process.stdout.write(text);
      partial += text;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) {
          if (!sessionId) sessionId = extractSessionId(line) ?? undefined;
          onChunk?.(line);
        }
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (!quiet) process.stderr.write(d);
    });
    child.on("exit", (code) => {
      if (partial.length > 0) {
        if (!sessionId) sessionId = extractSessionId(partial) ?? undefined;
        onChunk?.(partial);
      }
      resolve({ code: code ?? -1, sessionId });
    });
    child.on("error", () => resolve({ code: -1 }));
  });
}
