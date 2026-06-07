import { TemplateNotFoundError, type ITemplateEngine } from "@co/contracts";
import { ClaudeRunner, type BuildIdentityInput } from "./runner.js";

/**
 * Role → responsibilities template path mapping.
 * Single source of truth — previously duplicated in child-boot.ts and
 * in-process-supervisor.ts.
 */
export const ROLE_TO_SYSTEM_TEMPLATE: Record<string, string> = {
  planner: "agents/planner/responsibilities.md",
  executor: "agents/executor/responsibilities.md",
  verifier: "agents/verifier/responsibilities.md",
  reviewer: "agents/reviewer/responsibilities.md",
  accepter: "agents/accepter/responsibilities.md",
  explorer: "agents/explorer/responsibilities.md",
};

/**
 * Build the full system prompt for a worker by loading the identity
 * template (agents/worker-identity.md) and combining it with either:
 * - A dynamic system prompt provided by Leader (when input.dynamic_system_prompt is set)
 * - The legacy role-specific responsibilities template (fallback)
 *
 * Throws TemplateNotFoundError if required templates are missing — a
 * missing template is a configuration error that must fail fast.
 */
export function buildWorkerSystemPrompt(
  engine: ITemplateEngine,
  input: BuildIdentityInput,
): string {
  if (!engine.has("agents/worker-identity.md")) {
    throw new TemplateNotFoundError("agents/worker-identity.md");
  }
  const identityTpl = engine.load("agents/worker-identity.md");

  let contentTpl: string;

  if (input.dynamic_system_prompt) {
    // New path: use Leader-provided dynamic system prompt
    contentTpl = input.dynamic_system_prompt;
  } else {
    // Legacy path: load role-specific responsibilities template
    const roleTplName = ROLE_TO_SYSTEM_TEMPLATE[input.role];
    if (!roleTplName) {
      throw new TemplateNotFoundError(
        `agents/${input.role}/responsibilities.md`,
      );
    }
    if (!engine.has(roleTplName)) {
      throw new TemplateNotFoundError(roleTplName);
    }
    contentTpl = engine.load(roleTplName);
  }

  return ClaudeRunner.buildIdentityPrompt(
    [identityTpl, contentTpl].join("\n\n---\n\n"),
    input,
  );
}

/**
 * Variables consumed by workflow/decompose.md.
 * Intersection with Record<string, string> satisfies ITemplateEngine.render().
 */
export type DecomposeVars = {
  name: string;
  role: string;
  task_title: string;
  task_description: string;
  task_criteria: string;
  result_path: string;
  work_dir: string;
  time: string;
  content: string;
  co_root: string;
  magic_mode: string;
  magic_max_chains: string;
} & Record<string, string>;

/**
 * Render the leader's decompose prompt — thin wrapper over
 * ITemplateEngine.render that pins the template name so
 * callers and tests share one path.
 */
export function renderDecomposePrompt(
  engine: ITemplateEngine,
  vars: DecomposeVars,
): string {
  return engine.render("workflow/decompose.md", vars);
}
