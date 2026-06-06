export { TemplateEngine, LINK_TEMPLATES, type TemplateEngineOptions } from "./template.js";
export { ClaudeRunner, type BuildIdentityInput } from "./runner.js";
export { HookEngine, type HookEntry } from "./hook-engine.js";
export { extractJson } from "./json.js";
export {
  extractAssistantText,
  extractResultText,
  parseStreamLine,
} from "./stream-json.js";
export {
  buildWorkerSystemPrompt,
  renderDecomposePrompt,
  ROLE_TO_SYSTEM_TEMPLATE,
  type DecomposeVars,
} from "./identity.js";
