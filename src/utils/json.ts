/**
 * Extract a JSON object or array from markdown-fenced Claude output.
 * Handles: ```json ... ```,  ``` ... ```, and inline JSON with surrounding text.
 */
export function extractJson(content: string): string {
  let cleaned = content.trim();

  // Strip markdown code fences (anchored to start/end)
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");

  // Try to extract the first JSON object or array
  const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (match) return match[0].trim();

  // Fallback: global fence removal
  cleaned = cleaned.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  return cleaned;
}
