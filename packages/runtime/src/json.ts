/**
 * Extract a JSON object or array from a string that may contain
 * surrounding prose, markdown fences, or multiple JSON blocks.
 *
 * Strategy (in priority order):
 *   1. Try parsing the entire trimmed text as JSON.
 *   2. Strip markdown code fences and try parsing.
 *   3. Find all candidate `{...}` and `[...]` blocks using a
 *      bracket-depth tracker (handles nested braces correctly).
 *   4. Strip markdown headers and other formatting, then try parsing.
 *   5. If nothing parses, return the cleaned input as-is.
 */
export function extractJson(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";

  // 1. Try parsing entire text as JSON
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // not pure JSON — continue
  }

  // 2. Strip code fences and try parsing
  const withoutFences = stripCodeFences(trimmed);
  if (withoutFences !== trimmed) {
    try {
      JSON.parse(withoutFences);
      return withoutFences;
    } catch {
      // continue
    }
  }

  // 3. Find JSON-like blocks in the (fence-stripped) text
  const candidates = findJsonCandidates(withoutFences);
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // not valid JSON — try next candidate
    }
  }

  // 4. Strip markdown headers and formatting, then try parsing
  const stripped = stripMarkdownHeaders(withoutFences);
  if (stripped !== withoutFences) {
    try {
      JSON.parse(stripped);
      return stripped;
    } catch {
      // continue
    }
    // Also try finding JSON in the header-stripped version
    const headerCandidates = findJsonCandidates(stripped);
    for (const candidate of headerCandidates) {
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // continue
      }
    }
  }

  // 5. Nothing worked — return cleaned input as-is
  return withoutFences || trimmed;
}

/**
 * Strip markdown code fences from text.
 * Removes ```json ... ``` and plain ``` ... ``` blocks.
 */
function stripCodeFences(text: string): string {
  let result = text;
  // Remove opening/closing fence pairs
  result = result
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");
  // Remove standalone fence markers
  result = result.replace(/```json\s*/g, "").replace(/```\s*/g, "");
  return result.trim();
}

/**
 * Strip markdown headers and other formatting that can wrap JSON.
 * Handles: # Header, ## Header, **bold**, *italic*, etc.
 */
function stripMarkdownHeaders(text: string): string {
  let result = text;
  // Remove markdown headers (# through ######)
  result = result.replace(/^#{1,6}\s+.*$/gm, "");
  // Remove bold/italic markers
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  // Remove horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, "");
  // Collapse multiple blank lines
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
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
