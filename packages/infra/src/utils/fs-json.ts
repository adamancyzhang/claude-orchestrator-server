import * as fs from "node:fs";
import * as path from "node:path";

// Returns null ONLY when the file is absent (ENOENT). Every other read
// failure — directory in place of file, permission denied, I/O error — and
// any JSON parse error propagates so callers can distinguish "this layer
// is intentionally unset" from "this layer is broken."
export function readJson<T = unknown>(filePath: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw) as T;
}

export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
