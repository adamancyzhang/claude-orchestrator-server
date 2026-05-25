import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function escapeShell(s: string): string {
  return s.replace(/'/g, "'\\''");
}

export interface ExecStreamingOptions {
  command: string;
  prompt: string;
  log_path: string;
  system_prompt?: string;
  resume_session_id?: string;
  fork_session?: boolean;
  cwd?: string;
  quiet?: boolean;
  on_line?: (line: string) => void;
}

export interface ExecStreamingResult {
  exit_code: number;
  session_id: string | null;
  // Populated when the child process failed to spawn (binary not found,
  // permission denied, fork failure). Absent on every code path where the
  // child started — including when the child itself exits non-zero.
  spawn_error?: string;
}

export interface ExecCaptureResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  // Same contract as ExecStreamingResult.spawn_error.
  spawn_error?: string;
}

function tryExtractSessionId(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    if (obj && typeof obj.session_id === "string") return obj.session_id;
  } catch {
    // ignore JSON parse errors — stream-json includes non-JSON lines
  }
  return null;
}

export async function execWithStreaming(
  opts: ExecStreamingOptions,
): Promise<ExecStreamingResult> {
  await fs.promises.mkdir(path.dirname(opts.log_path), { recursive: true });

  let flags = "--output-format stream-json --verbose";
  if (opts.system_prompt) {
    flags += ` --append-system-prompt '${escapeShell(opts.system_prompt)}'`;
  }
  if (opts.resume_session_id) {
    flags += ` --resume '${escapeShell(opts.resume_session_id)}'`;
  }
  if (opts.fork_session) {
    flags += " --fork-session";
  }

  const shellCmd = `exec ${opts.command} ${flags} -p '${escapeShell(opts.prompt)}' | tee -a '${escapeShell(opts.log_path)}'`;

  if (!opts.quiet) {
    const msgPreview =
      opts.prompt.length > 100 ? opts.prompt.slice(0, 100) + "..." : opts.prompt;
    console.log(
      `\n[Exec] ${opts.command} -p '${msgPreview}' | tee -a '${opts.log_path}'`,
    );
  }

  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", shellCmd], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let partial = "";
    let sessionId: string | null = null;

    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString();
      if (!opts.quiet) process.stdout.write(text);
      partial += text;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) {
          if (!sessionId) sessionId = tryExtractSessionId(line);
          opts.on_line?.(line);
        }
      }
    });

    child.stderr?.on("data", (d: Buffer) => {
      if (!opts.quiet) process.stderr.write(d);
    });

    child.on("exit", (code) => {
      if (partial.length > 0) {
        if (!sessionId) sessionId = tryExtractSessionId(partial);
        opts.on_line?.(partial);
      }
      resolve({ exit_code: code ?? -1, session_id: sessionId });
    });

    child.on("error", (err) =>
      resolve({
        exit_code: -1,
        session_id: null,
        spawn_error: String(err),
      }),
    );
  });
}

export async function execAndCapture(
  command: string,
  args: readonly string[] = [],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecCaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("exit", (code) =>
      resolve({ exit_code: code ?? -1, stdout, stderr }),
    );
    child.on("error", (err) =>
      resolve({
        exit_code: -1,
        stdout,
        stderr,
        spawn_error: String(err),
      }),
    );
  });
}
