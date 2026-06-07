// Input validation and XSS protection for dashboard API
// Sanitizes user input to prevent injection attacks

/**
 * Characters that are dangerous in HTML context.
 * Maps each character to its HTML entity equivalent.
 */
const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
  "/": "&#x2F;",
};

/**
 * Escape HTML special characters in a string to prevent XSS.
 */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"'/]/g, (char) => HTML_ESCAPE_MAP[char] ?? char);
}

/**
 * Sanitize a string for safe use in JSON responses.
 * Escapes HTML entities to prevent reflected XSS.
 */
export function sanitizeString(input: string): string {
  return escapeHtml(input);
}

/**
 * Validate that a string matches an expected pattern.
 * Returns true if the string matches, false otherwise.
 */
export function matchesPattern(input: string, pattern: RegExp): boolean {
  return pattern.test(input);
}

/**
 * Validate a string is within length bounds.
 */
export function isValidLength(input: string, min: number, max: number): boolean {
  return input.length >= min && input.length <= max;
}

/**
 * Validate that a string contains only safe characters (alphanumeric, dash, underscore, dot).
 * Useful for validating identifiers, filenames, etc.
 */
export function isSafeIdentifier(input: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(input);
}

/**
 * Validate that a string is a valid URL path (no protocol, no query params).
 */
export function isValidPath(input: string): boolean {
  // Must start with /, no double dots for traversal, no query strings
  return /^\/[a-zA-Z0-9._/~-]*$/.test(input) && !input.includes("..");
}

/**
 * Validate that a string is a valid semver-like version string.
 */
export function isValidVersion(input: string): boolean {
  return /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/.test(input);
}

/**
 * Limit the size of a string to prevent DoS via large payloads.
 * Returns the truncated string if it exceeds maxLength.
 */
export function truncateString(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }
  return input.slice(0, maxLength);
}

/**
 * Validate a JSON payload size is within acceptable limits.
 * Returns true if the raw body size is under the limit.
 */
export function isPayloadSizeValid(rawBody: string, maxBytes: number): boolean {
  // Use Buffer.byteLength for accurate byte counting (handles multi-byte chars)
  return Buffer.byteLength(rawBody, "utf-8") <= maxBytes;
}

/**
 * Configuration for request body validation.
 */
export interface BodyValidationConfig {
  /** Maximum body size in bytes (default: 1MB) */
  maxBodySize?: number;
  /** Maximum number of keys in JSON object (default: 50) */
  maxObjectKeys?: number;
  /** Maximum nesting depth (default: 5) */
  maxDepth?: number;
}

const DEFAULT_CONFIG: Required<BodyValidationConfig> = {
  maxBodySize: 1024 * 1024, // 1MB
  maxObjectKeys: 50,
  maxDepth: 5,
};

/**
 * Validate a parsed JSON object for structural safety.
 * Checks for excessive nesting, too many keys, etc.
 */
export function validateJsonStructure(
  obj: unknown,
  config: BodyValidationConfig = {},
): { valid: boolean; error?: string } {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  function checkDepth(value: unknown, depth: number): { valid: boolean; error?: string } {
    if (depth > cfg.maxDepth) {
      return { valid: false, error: `JSON nesting depth exceeds limit of ${cfg.maxDepth}` };
    }

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const keys = Object.keys(value as Record<string, unknown>);
      if (keys.length > cfg.maxObjectKeys) {
        return { valid: false, error: `JSON object has ${keys.length} keys, limit is ${cfg.maxObjectKeys}` };
      }
      for (const key of keys) {
        // Validate key names are safe
        if (!isSafeIdentifier(key) && key.length > 0) {
          return { valid: false, error: `Invalid JSON key: "${truncateString(key, 50)}"` };
        }
        const result = checkDepth((value as Record<string, unknown>)[key], depth + 1);
        if (!result.valid) {
          return result;
        }
      }
    } else if (Array.isArray(value)) {
      if (value.length > cfg.maxObjectKeys) {
        return { valid: false, error: `JSON array has ${value.length} elements, limit is ${cfg.maxObjectKeys}` };
      }
      for (const item of value) {
        const result = checkDepth(item, depth + 1);
        if (!result.valid) {
          return result;
        }
      }
    }

    return { valid: true };
  }

  return checkDepth(obj, 0);
}
