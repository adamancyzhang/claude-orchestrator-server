import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";


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

  const args: string[] = [
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (opts.system_prompt) {
    args.push("--append-system-prompt", opts.system_prompt);
  }
  if (opts.resume_session_id) {
    args.push("--resume", opts.resume_session_id);
  }
  if (opts.fork_session) {
    args.push("--fork-session");
  }
  args.push("-p", opts.prompt);

  // Split command string into executable and extra args. The config
  // stores commands like "claude --dangerously-skip-permissions ..." as a
  // single string, but spawn() expects the executable as the first arg
  // and flags as separate array elements.
  const commandParts = opts.command.split(/\s+/).filter(Boolean);
  const executable = commandParts[0];
  const commandArgs = commandParts.slice(1);

  if (!opts.quiet) {
    const msgPreview =
      opts.prompt.length > 100 ? opts.prompt.slice(0, 100) + "..." : opts.prompt;
    console.log(`\n[Exec] ${executable} ${[...commandArgs, ...args].join(" ")}`);
  }

  return new Promise((resolve) => {
    const logStream = fs.createWriteStream(opts.log_path, { flags: "a" });

    const child = spawn(executable, [...commandArgs, ...args], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let partial = "";
    let sessionId: string | null = null;

    child.stdout?.on("data", (d: Buffer) => {
      if (!opts.quiet) process.stdout.write(d);
      logStream.write(d);
      const text = d.toString();
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
      logStream.end(() => {
        resolve({ exit_code: code ?? -1, session_id: sessionId });
      });
    });

    child.on("error", (err) => {
      logStream.end(() => {
        resolve({
          exit_code: -1,
          session_id: null,
          spawn_error: String(err),
        });
      });
    });
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
    // Use 'close' instead of 'exit' to avoid a race condition where the
    // exit event fires before all data has been read from stdout/stderr.
    child.on("close", (code) =>
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
