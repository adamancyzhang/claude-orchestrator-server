import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StreamTailer } from "../../../src/leader/stream-tailer.js";

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-tailer-"));
  return path.join(dir, "log.txt");
}

describe("StreamTailer", () => {
  let tailer: StreamTailer;
  afterEach(() => { tailer?.stop(); });

  it("reads new lines as the file grows", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "");
    const lines: string[] = [];
    tailer = new StreamTailer(20);
    tailer.start(file, (l) => lines.push(l));

    fs.appendFileSync(file, "first\n");
    fs.appendFileSync(file, "second\n");
    await new Promise((r) => setTimeout(r, 80));

    expect(lines).toContain("first");
    expect(lines).toContain("second");
  });

  it("resets lastPosition when file shrinks (rotation)", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "aaaaaaaaaa\nbbbbbbbbbb\nccccccccc\n");
    const lines: string[] = [];
    tailer = new StreamTailer(20);
    tailer.start(file, (l) => lines.push(l));
    await new Promise((r) => setTimeout(r, 60));
    expect(lines.length).toBeGreaterThanOrEqual(3);

    // Simulate rotation: shrink the file dramatically.
    fs.writeFileSync(file, "x\n");
    // First poll after rotation detects shrink and resets position to 0.
    await new Promise((r) => setTimeout(r, 60));
    // Second poll after that reads the new content.
    fs.appendFileSync(file, "after-rotate\n");
    await new Promise((r) => setTimeout(r, 60));
    expect(lines).toContain("after-rotate");
  });

  it("skips empty lines from split", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "a\n\nb\n");
    const lines: string[] = [];
    tailer = new StreamTailer(20);
    tailer.start(file, (l) => lines.push(l));
    await new Promise((r) => setTimeout(r, 60));
    expect(lines).toEqual(["a", "b"]);
  });

  it("stop() halts the poll timer", async () => {
    const file = tmpFile();
    fs.writeFileSync(file, "");
    tailer = new StreamTailer(20);
    tailer.start(file, vi.fn());
    expect(tailer.isActive).toBe(true);
    tailer.stop();
    expect(tailer.isActive).toBe(false);
  });
});
