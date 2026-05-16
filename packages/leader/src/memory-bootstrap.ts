import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  cachePaths,
  type IClaudeRunner,
  type ILogger,
  type ITemplateEngine,
} from "@co/contracts";

export interface MemoryBootstrapOptions {
  cache_paths: cachePaths.CachePathOptions;
  workspace_root: string;
  runner: IClaudeRunner;
  template_engine: ITemplateEngine;
  logger: ILogger;
  /**
   * Globs interpreted by `git ls-files`. Defaults to TypeScript sources under
   * `packages/`. Each glob is passed as a separate pathspec argument so git
   * unions the matches.
   */
  source_globs?: string[];
  /**
   * Per-file template name. Defaults to `worker-memorize-file.md`.
   */
  file_template?: string;
  /**
   * Per-directory template name. Defaults to `worker-memorize-dir.md`.
   */
  dir_template?: string;
}

const DEFAULT_GLOBS = ["packages/**/*.ts"];
const DEFAULT_FILE_TEMPLATE = "worker-memorize-file.md";
const DEFAULT_DIR_TEMPLATE = "worker-memorize-dir.md";

export interface BootstrapStats {
  files_generated: number;
  files_skipped: number;
  files_failed: number;
  dirs_generated: number;
  dirs_failed: number;
}

export interface StaleEntry {
  source: string;       // relative source path, e.g. "packages/worker/src/watcher.ts"
  memory_path: string;  // absolute path to the memory .md file
  recorded_hash: string; // hash stored in front-matter (may be empty)
  current_hash: string;  // hash of the source file as it currently is
}

/**
 * Generates the initial workspace memory tree under
 * `${root}/memory/` by mirroring the project source layout.
 *
 * Lifecycle: invoked at Leader startup; runs in the background; idempotent.
 * If the memory root already contains any content the bootstrap is a no-op,
 * leaving incremental refresh (Phase 2.2) to keep it current.
 *
 * The bootstrap reads only **tracked** source files via `git ls-files`, so
 * generated code, build outputs, and node_modules are excluded by virtue of
 * not being in the index.
 */
export class MemoryBootstrap {
  constructor(private readonly opts: MemoryBootstrapOptions) {}

  /**
   * Returns `true` if the memory tree appears to have been generated already.
   * The marker is the existence of the root index `memory/CLAUDE.md` — set
   * only after a successful pass.
   */
  isPopulated(): boolean {
    const root = cachePaths.workspaceMemoryRoot(this.opts.cache_paths);
    const rootIndex = path.join(root, "CLAUDE.md");
    return fs.existsSync(rootIndex);
  }

  /**
   * Lists tracked source files matching `source_globs` (default:
   * `packages/**` *.ts`) under `workspace_root`, deduped and sorted.
   * Returns paths **relative to `workspace_root`**.
   */
  enumerateSources(): string[] {
    const globs = this.opts.source_globs ?? DEFAULT_GLOBS;
    let raw = "";
    try {
      raw = execSync(
        `git ls-files -- ${globs.map((g) => `'${g}'`).join(" ")}`,
        {
          cwd: this.opts.workspace_root,
          encoding: "utf-8",
        },
      );
    } catch (err) {
      this.opts.logger.warn("memory bootstrap: git ls-files failed", {
        error: String(err),
      });
      return [];
    }
    const seen = new Set<string>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) seen.add(trimmed);
    }
    return Array.from(seen).sort();
  }

  /**
   * Group source files by their parent directory (relative to workspace
   * root). Returned map preserves discovery order and lists files in the
   * order given.
   */
  groupByDir(sources: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const s of sources) {
      const dir = path.posix.dirname(s);
      const list = map.get(dir);
      if (list) list.push(s);
      else map.set(dir, [s]);
    }
    return map;
  }

  /**
   * Compute `git hash-object <path>` for one file. Returns empty string on
   * failure so callers can embed a placeholder in the front-matter.
   */
  private fileHash(relativePath: string): string {
    try {
      return execSync(`git hash-object '${relativePath}'`, {
        cwd: this.opts.workspace_root,
        encoding: "utf-8",
      }).trim();
    } catch {
      return "";
    }
  }

  /**
   * Generate per-file memory entries by rendering `file_template` once per
   * source file and invoking the Claude runner. Failures are logged and
   * counted; one failing file does not abort the pass.
   *
   * @param mode When `"skip-existing"`, files whose memory already exists
   *   on disk are counted as skipped and left alone (used by the initial
   *   bootstrap to keep restarts cheap). When `"force"`, existing memory
   *   files are overwritten — used by incremental refresh after a commit
   *   so the stored `source_hash` catches up with the new source.
   */
  private async generateFiles(
    sources: string[],
    mode: "skip-existing" | "force" = "skip-existing",
  ): Promise<{
    generated: number;
    skipped: number;
    failed: number;
  }> {
    let generated = 0;
    let skipped = 0;
    let failed = 0;
    const tplName = this.opts.file_template ?? DEFAULT_FILE_TEMPLATE;
    if (!this.opts.template_engine.has(tplName)) {
      this.opts.logger.warn("memory bootstrap: file template missing", {
        template: tplName,
      });
      return { generated: 0, skipped: 0, failed: sources.length };
    }
    const date = new Date().toISOString().slice(0, 10);
    for (const source of sources) {
      const resultPath = cachePaths.workspaceMemoryFilePath(
        this.opts.cache_paths,
        source,
      );
      if (mode === "skip-existing" && fs.existsSync(resultPath)) {
        skipped += 1;
        continue;
      }
      await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });
      const logPath = `${resultPath}.log`;
      const prompt = this.opts.template_engine.render(tplName, {
        source_path: source,
        source_hash: this.fileHash(source),
        work_dir: this.opts.workspace_root,
        result_path: resultPath,
        date,
      });
      try {
        const r = await this.opts.runner.run({
          prompt,
          log_path: logPath,
          cwd: this.opts.workspace_root,
          quiet: true,
        });
        if (r.exit_code === 0 && fs.existsSync(resultPath)) {
          generated += 1;
        } else {
          failed += 1;
          this.opts.logger.warn("memory bootstrap: file generation failed", {
            source,
            exit_code: r.exit_code,
            log_path: logPath,
          });
        }
      } catch (err) {
        failed += 1;
        this.opts.logger.warn("memory bootstrap: runner threw", {
          source,
          error: String(err),
        });
      }
    }
    return { generated, skipped, failed };
  }

  /**
   * Read the `source` and `source_hash` lines from a memory file's front-
   * matter. Returns null when the file cannot be opened or front-matter is
   * missing. Front-matter is a simple `---\nkey: value\n...\n---` block at
   * the start of the file — we do not bring in a YAML parser dependency.
   */
  private readFrontMatter(
    memoryPath: string,
  ): { source: string; source_hash: string } | null {
    let body = "";
    try {
      body = fs.readFileSync(memoryPath, "utf-8");
    } catch {
      return null;
    }
    const match = body.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return null;
    const lines = match[1].split("\n");
    let source = "";
    let hash = "";
    for (const line of lines) {
      const m = line.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      const value = m[2].trim();
      if (key === "source") source = value;
      else if (key === "source_hash") hash = value;
    }
    if (!source) return null;
    return { source, source_hash: hash };
  }

  /**
   * Walk the memory tree and return every per-file summary whose stored
   * `source_hash` no longer matches `git hash-object` for the current
   * source. Files whose `source_hash` is empty (failed initial generation)
   * are also returned so a refresh pass can fill them in. Directory
   * indexes (CLAUDE.md) are skipped — their staleness derives from the
   * files they reference.
   */
  async findStaleEntries(): Promise<StaleEntry[]> {
    const root = cachePaths.workspaceMemoryRoot(this.opts.cache_paths);
    if (!fs.existsSync(root)) return [];
    const stale: StaleEntry[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(".md")) continue;
        if (entry.name === "CLAUDE.md") continue;
        const fm = this.readFrontMatter(full);
        if (!fm) continue;
        const currentHash = this.fileHash(fm.source);
        if (currentHash === "") continue; // source disappeared — separate concern
        if (currentHash !== fm.source_hash) {
          stale.push({
            source: fm.source,
            memory_path: full,
            recorded_hash: fm.source_hash,
            current_hash: currentHash,
          });
        }
      }
    };
    await walk(root);
    return stale;
  }

  /**
   * Convenience: find stale entries and immediately refresh them.
   * Returns the underlying refreshFiles stats with the stale count so
   * callers can log a single summary at startup.
   */
  async refreshStale(): Promise<{
    stale_found: number;
    generated: number;
    failed: number;
    filtered_out: number;
  }> {
    const stale = await this.findStaleEntries();
    if (stale.length === 0) {
      return { stale_found: 0, generated: 0, failed: 0, filtered_out: 0 };
    }
    const sources = stale.map((s) => s.source);
    const stats = await this.refreshFiles(sources);
    return {
      stale_found: stale.length,
      ...stats,
    };
  }

  /**
   * Force-refresh a specific set of source files. Bypasses the populated
   * sentinel and the skip-existing rule — used by ChainRouter after a
   * Worker commit so the memory for changed files catches up. Filters out
   * any paths that don't match the configured `source_globs` so callers
   * can pass an unsanitised diff list.
   *
   * Returns the per-source counts the caller can log.
   */
  async refreshFiles(sources: string[]): Promise<{
    generated: number;
    failed: number;
    filtered_out: number;
  }> {
    const allowed = new Set(this.enumerateSources());
    const filtered: string[] = [];
    let filteredOut = 0;
    for (const s of sources) {
      const normalized = s.replace(/^\.\//, "").replace(/^\/+/, "");
      if (allowed.has(normalized)) filtered.push(normalized);
      else filteredOut += 1;
    }
    if (filtered.length === 0) {
      return { generated: 0, failed: 0, filtered_out: filteredOut };
    }
    const fileStats = await this.generateFiles(filtered, "force");
    // Refresh the per-directory CLAUDE.md indexes affected by the change
    // so their `关键文件清单` reflects updated Purpose lines. `generateDirs`
    // skips dirs whose index already exists, so we delete first.
    const grouped = this.groupByDir(filtered);
    for (const dir of grouped.keys()) {
      const idxPath = cachePaths.workspaceMemoryDirIndexPath(
        this.opts.cache_paths,
        dir,
      );
      try {
        await fs.promises.unlink(idxPath);
      } catch {
        // missing is fine; generateDirs will create it
      }
    }
    await this.generateDirs(grouped);
    return {
      generated: fileStats.generated,
      failed: fileStats.failed,
      filtered_out: filteredOut,
    };
  }

  /**
   * Read the `## Purpose` section of an already-generated file summary so
   * directory-level prompts can reference each file in one line without
   * re-opening the source. Returns an empty string when the section is
   * absent.
   */
  private readPurpose(memoryFilePath: string): string {
    let body = "";
    try {
      body = fs.readFileSync(memoryFilePath, "utf-8");
    } catch {
      return "";
    }
    const match = body.match(/##\s+Purpose\s*\n([\s\S]*?)(?=\n##\s|$)/);
    if (!match) return "";
    return match[1].trim().split("\n").join(" ").slice(0, 200);
  }

  /**
   * Build the `{{file_summaries_block}}` payload the directory template
   * expects. Each line is `- <basename>: <Purpose>` — short, easy for
   * Claude to scan.
   */
  buildFileSummariesBlock(dir: string, files: string[]): string {
    const lines: string[] = [];
    for (const source of files) {
      const memoryPath = cachePaths.workspaceMemoryFilePath(
        this.opts.cache_paths,
        source,
      );
      const purpose = this.readPurpose(memoryPath);
      const base = path.posix.basename(source);
      lines.push(purpose ? `- ${base}: ${purpose}` : `- ${base}: (no summary)`);
    }
    return lines.length === 0 ? "(none)" : lines.join("\n");
  }

  private async generateDirs(grouped: Map<string, string[]>): Promise<{
    generated: number;
    failed: number;
  }> {
    let generated = 0;
    let failed = 0;
    const tplName = this.opts.dir_template ?? DEFAULT_DIR_TEMPLATE;
    if (!this.opts.template_engine.has(tplName)) {
      this.opts.logger.warn("memory bootstrap: dir template missing", {
        template: tplName,
      });
      return { generated: 0, failed: grouped.size };
    }
    const date = new Date().toISOString().slice(0, 10);
    for (const [dir, files] of grouped) {
      const resultPath = cachePaths.workspaceMemoryDirIndexPath(
        this.opts.cache_paths,
        dir,
      );
      if (fs.existsSync(resultPath)) continue;
      await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });
      const logPath = `${resultPath}.log`;
      const prompt = this.opts.template_engine.render(tplName, {
        dir_path: dir,
        work_dir: this.opts.workspace_root,
        result_path: resultPath,
        date,
        file_summaries_block: this.buildFileSummariesBlock(dir, files),
      });
      try {
        const r = await this.opts.runner.run({
          prompt,
          log_path: logPath,
          cwd: this.opts.workspace_root,
          quiet: true,
        });
        if (r.exit_code === 0 && fs.existsSync(resultPath)) {
          generated += 1;
        } else {
          failed += 1;
          this.opts.logger.warn("memory bootstrap: dir generation failed", {
            dir,
            exit_code: r.exit_code,
            log_path: logPath,
          });
        }
      } catch (err) {
        failed += 1;
        this.opts.logger.warn("memory bootstrap: dir runner threw", {
          dir,
          error: String(err),
        });
      }
    }
    return { generated, failed };
  }

  /**
   * Mark the bootstrap as complete by writing a minimal root index. The
   * presence of this file is what `isPopulated()` checks — incremental
   * refresh later may replace or extend it.
   */
  private async writeRootMarker(stats: BootstrapStats): Promise<void> {
    const root = cachePaths.workspaceMemoryRoot(this.opts.cache_paths);
    const rootIndex = path.join(root, "CLAUDE.md");
    await fs.promises.mkdir(root, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const body =
      `---\n` +
      `dir: .\n` +
      `updated_at: ${date}\n` +
      `bootstrap_files: ${stats.files_generated + stats.files_skipped}\n` +
      `bootstrap_dirs: ${stats.dirs_generated}\n` +
      `---\n\n` +
      `# Workspace Memory\n\n` +
      `Per-file summaries live alongside their source under \`packages/...\`.\n` +
      `Each directory carries a \`CLAUDE.md\` index. See\n` +
      `\`docs/v0.6/dd/workspace-memory.md\` for the design.\n`;
    await fs.promises.writeFile(rootIndex, body, "utf-8");
  }

  /**
   * Full bootstrap pass. Safe to invoke repeatedly: existing memory files
   * are skipped, and the whole pass is a no-op once the root marker is
   * present. Returns counts so the caller can log a summary.
   */
  async run(): Promise<BootstrapStats> {
    if (this.isPopulated()) {
      this.opts.logger.info("memory bootstrap: already populated, skipping");
      return {
        files_generated: 0,
        files_skipped: 0,
        files_failed: 0,
        dirs_generated: 0,
        dirs_failed: 0,
      };
    }
    const sources = this.enumerateSources();
    this.opts.logger.info("memory bootstrap: starting", {
      source_count: sources.length,
    });
    const fileStats = await this.generateFiles(sources);
    const grouped = this.groupByDir(sources);
    const dirStats = await this.generateDirs(grouped);
    const stats: BootstrapStats = {
      files_generated: fileStats.generated,
      files_skipped: fileStats.skipped,
      files_failed: fileStats.failed,
      dirs_generated: dirStats.generated,
      dirs_failed: dirStats.failed,
    };
    await this.writeRootMarker(stats);
    this.opts.logger.info("memory bootstrap: done", {
      files_generated: stats.files_generated,
      files_skipped: stats.files_skipped,
      files_failed: stats.files_failed,
      dirs_generated: stats.dirs_generated,
      dirs_failed: stats.dirs_failed,
    });
    return stats;
  }
}
