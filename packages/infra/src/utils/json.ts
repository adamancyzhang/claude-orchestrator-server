export function extractJson(content: string): string {
  let cleaned = content.trim();
  cleaned = cleaned
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");
  const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (match) return match[0].trim();
  cleaned = cleaned.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  return cleaned;
}
