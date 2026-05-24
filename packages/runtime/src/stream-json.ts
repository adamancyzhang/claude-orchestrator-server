/**
 * Parser for claude CLI `--output-format stream-json --verbose` output.
 *
 * Each line is a JSON object with a top-level `type` field:
 *   - "system": initialization metadata (subtype: "init")
 *   - "assistant": LLM response with `message.content` array of content blocks
 *   - "result": final result summary (subtype: "success" / "error")
 *
 * Content blocks within assistant messages:
 *   - { type: "text", text: "..." }         — visible assistant response
 *   - { type: "thinking", thinking: "..." } — internal reasoning (hidden)
 *   - { type: "tool_use", ... }             — tool call (not extracted)
 */

interface StreamContentBlock {
  type: string;
  text?: string;
  thinking?: string;
}

interface StreamAssistant {
  type: "assistant";
  message?: {
    content?: StreamContentBlock[];
  };
}

interface StreamResult {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  stop_reason?: string;
  session_id?: string;
}

type StreamLine = StreamAssistant | StreamResult | { type: string };

/**
 * Parse a single stream-json line and extract visible assistant text.
 * Returns null for non-assistant messages or assistant messages with
 * no text content (thinking-only).
 */
export function extractAssistantText(line: string): string | null {
  if (!line.trim()) return null;

  let parsed: StreamLine;
  try {
    parsed = JSON.parse(line) as StreamLine;
  } catch {
    return null;
  }

  if (parsed.type !== "assistant") return null;

  const content = (parsed as StreamAssistant).message?.content;
  if (!content || content.length === 0) return null;

  const texts = content
    .filter((block): block is StreamContentBlock & { text: string } =>
      block.type === "text" && typeof block.text === "string" && block.text.length > 0
    )
    .map((block) => block.text);

  return texts.length > 0 ? texts.join("") : null;
}

/**
 * Parse a stream-json line and return the result text for "result" type
 * messages. Returns null for non-result messages.
 */
export function extractResultText(line: string): string | null {
  if (!line.trim()) return null;

  let parsed: StreamResult;
  try {
    parsed = JSON.parse(line) as StreamResult;
  } catch {
    return null;
  }

  if (parsed.type !== "result") return null;
  return parsed.result ?? null;
}
