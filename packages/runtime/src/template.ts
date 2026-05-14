import * as fs from "node:fs";
import path from "node:path";
import { TemplateNotFoundError, type ITemplateEngine } from "@co/contracts";

export const LINK_TEMPLATES = [
  "plan",
  "build",
  "verify",
  "review",
  "accept",
  "decompose",
] as const;

export interface TemplateEngineOptions {
  primary_dir: string;
  fallback_dir?: string;
}

export class TemplateEngine implements ITemplateEngine {
  private readonly cache = new Map<string, string>();

  constructor(private readonly opts: TemplateEngineOptions) {}

  load(name: string): string {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const primary = path.join(this.opts.primary_dir, name);
    if (fs.existsSync(primary)) {
      const body = fs.readFileSync(primary, "utf-8");
      this.cache.set(name, body);
      return body;
    }
    if (this.opts.fallback_dir) {
      const fallback = path.join(this.opts.fallback_dir, name);
      if (fs.existsSync(fallback)) {
        const body = fs.readFileSync(fallback, "utf-8");
        this.cache.set(name, body);
        return body;
      }
    }
    throw new TemplateNotFoundError(name);
  }

  render(name: string, vars: Record<string, string>): string {
    const body = this.load(name);
    let out = body;
    for (const [key, value] of Object.entries(vars)) {
      out = out.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
    }
    return out;
  }

  has(name: string): boolean {
    const primary = path.join(this.opts.primary_dir, name);
    if (fs.existsSync(primary)) return true;
    if (this.opts.fallback_dir) {
      const fallback = path.join(this.opts.fallback_dir, name);
      if (fs.existsSync(fallback)) return true;
    }
    return false;
  }
}
