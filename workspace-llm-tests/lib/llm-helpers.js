import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/** Resolve segments relative to the project root. If first segment is already absolute, returns it joined with remaining segments. */
export function projectPath(...segments) {
  if (segments.length > 0 && path.isAbsolute(segments[0])) {
    return path.join(...segments);
  }
  return path.join(PROJECT_ROOT, ...segments);
}

/**
 * Render a template file by replacing {{placeholder}} variables.
 * Mimics WorkerWatcher.renderTemplate() behavior.
 */
export async function renderTemplate(templatePath, variables) {
  let content = await readFile(templatePath, "utf-8");
  for (const [key, value] of Object.entries(variables)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value ?? "");
  }
  return content;
}

/**
 * Execute a prompt via claude CLI and capture output.
 *
 * @param {string} prompt - The rendered template prompt
 * @param {{ timeoutMs?: number, workDir?: string, model?: string }} options
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
export function runClaude(prompt, { timeoutMs = 300000, workDir, model } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--dangerously-skip-permissions",
      "--permission-mode", "dontAsk",
    ];
    if (model) args.push("--model", model);

    const child = spawn("claude", args, {
      cwd: workDir || PROJECT_ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? -1 });
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/**
 * Validate worker output against expected role patterns.
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateWorkerOutput(output, expectedLink) {
  const errors = [];
  const warnings = [];

  if (!output || output.length < 20) {
    errors.push("Output is empty or too short");
    return { valid: false, errors, warnings };
  }

  // Check for error markers
  const errorPatterns = [
    /^(Error|TypeError|ReferenceError|SyntaxError):/m,
    /^\[ERROR\]/m,
    /Permission denied/i,
  ];
  for (const pat of errorPatterns) {
    if (pat.test(output)) {
      errors.push(`Output contains error marker: ${pat}`);
    }
  }

  // Check Link header (accepts "Link: plan" or "**Link**: plan" or "Link plan")
  if (!new RegExp(`Link[:\\s]+${expectedLink}`, "i").test(output)) {
    errors.push(`Missing or wrong "Link:" reference (expected "${expectedLink}")`);
  }

  // Check Status field (accepts "Status: completed" or "**Status**: completed")
  if (!/Status[:*]*\s*\S/i.test(output)) {
    errors.push('Missing "Status:" field');
  }

  // Role-specific section checks (flexible matching)
  const roleChecks = {
    plan: [/Blueprint/i, /Build Steps/i],
    build: [/Evidence|Implemented/i],
    verify: [/Verif|Passed/i, /Recommend/i],
    review: [/Decision/i, /Concern|Accept/i],
    accept: [/Decision/i, /Criteria/i, /GO|NO-GO/i],
  };

  const checks = roleChecks[expectedLink] || [];
  for (const pattern of checks) {
    if (!pattern.test(output)) {
      warnings.push(`Expected section matching "${pattern}" not found`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate Leader decide output — tries to extract and parse JSON.
 */
export function validateLeaderDecision(output) {
  const errors = [];
  const warnings = [];

  if (!output || output.length < 10) {
    errors.push("Output is empty or too short");
    return { valid: false, errors, warnings, parsed: null };
  }

  // Try to extract JSON block (```json ... ``` or raw JSON)
  let parsed = null;
  const jsonBlock = output.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const candidate = jsonBlock ? jsonBlock[1].trim() : output.trim();

  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Try to find JSON object anywhere in the output
    const objMatch = output.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        parsed = JSON.parse(objMatch[0]);
      } catch {
        errors.push("Could not parse JSON from output");
      }
    } else {
      errors.push("No JSON object found in output");
    }
  }

  if (parsed) {
    if (!parsed.decision) errors.push("Missing 'decision' field in parsed JSON");
    if (!parsed.reason) warnings.push("Missing 'reason' field in parsed JSON");
    if (!parsed.next_action) errors.push("Missing 'next_action' field in parsed JSON");
  }

  return { valid: errors.length === 0, errors, warnings, parsed };
}

/**
 * Wrap a test function with PASS/FAIL output and timing.
 */
export async function runScenario(name, fn) {
  const start = Date.now();
  try {
    await fn();
    console.log(`PASS [${Date.now() - start}ms] ${name}`);
  } catch (err) {
    console.log(`FAIL [${Date.now() - start}ms] ${name}`);
    console.error(`  ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

/** Simple assertion */
export function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}
