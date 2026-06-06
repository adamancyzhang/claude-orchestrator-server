/**
 * Extract a JSON object or array from a string that may contain
 * surrounding prose, markdown fences, or multiple JSON blocks.
 *
 * Strategy:
 *   1. Strip markdown code fences (```json ... ```).
 *   2. Find all candidate `{...}` and `[...]` blocks using a
 *      bracket-depth tracker (handles nested braces correctly,
 *      unlike a naive regex).
 *   3. Return the first candidate that parses as valid JSON.
 *   4. If nothing parses, return the cleaned input as-is.
 */
export function extractJson(content: string): string {
  let cleaned = content.trim();
  cleaned = cleaned
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");
  cleaned = cleaned.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

  const candidates = findJsonCandidates(cleaned);
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // not valid JSON — try next candidate
    }
  }
  return cleaned;
}

/**
 * Scan `text` and return all balanced `{...}` and `[...]` substrings,
 * ordered by start position. Handles nested brackets correctly.
 */
function findJsonCandidates(text: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]";
      const start = i;
      let depth = 1;
      i++;
      while (i < text.length && depth > 0) {
        if (text[i] === ch) depth++;
        else if (text[i] === close) depth--;
        i++;
      }
      if (depth === 0) {
        results.push(text.slice(start, i));
      }
    }
  }
  return results;
}
