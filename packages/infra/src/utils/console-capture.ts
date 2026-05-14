import * as fs from "node:fs";
import * as path from "node:path";

const originals = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
};

let captured = false;
let stream: fs.WriteStream | null = null;

export function captureConsoleToFile(logDir: string): void {
  if (captured) return;
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `leader-${Date.now()}.log`);
  stream = fs.createWriteStream(logPath, { flags: "a" });

  const write = (level: string, ...args: unknown[]) => {
    const ts = new Date().toISOString();
    const text = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    stream?.write(`[${level}] ${ts} ${text}\n`);
  };

  console.log = (...args) => write("LOG", ...args);
  console.error = (...args) => write("ERROR", ...args);
  console.warn = (...args) => write("WARN", ...args);
  console.info = (...args) => write("INFO", ...args);
  console.debug = (...args) => write("DEBUG", ...args);

  captured = true;
}

export function restoreConsole(): void {
  if (!captured) return;
  console.log = originals.log;
  console.error = originals.error;
  console.warn = originals.warn;
  console.info = originals.info;
  console.debug = originals.debug;
  stream?.end();
  stream = null;
  captured = false;
}
