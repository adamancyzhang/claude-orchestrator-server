import { vi } from "vitest";

export class MockTemplateEngine {
  private templates = new Map<string, string>();
  private files = new Map<string, string>();

  setTemplate(link: string, content: string): void {
    this.templates.set(link, content);
  }

  setFile(filename: string, content: string): void {
    this.files.set(filename, content);
  }

  get = vi.fn((link: string): string | undefined => this.templates.get(link));

  loadAll = vi.fn(async () => {});

  loadFile = vi.fn(async (filename: string): Promise<string> => {
    const content = this.files.get(filename);
    if (content === undefined) {
      throw new Error(`Template ${filename} not registered in MockTemplateEngine`);
    }
    return content;
  });

  render = vi.fn((template: string, vars: Record<string, string>): string => {
    let body = template;
    for (const [k, v] of Object.entries(vars)) {
      body = body.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v);
    }
    return body;
  });
}
