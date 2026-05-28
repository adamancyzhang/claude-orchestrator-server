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
 *   - { type: "thinking", thinking: "..." } — internal reasoning (kind only,
 *                                              content not exposed upstream)
 *   - { type: "tool_use", name, input }     — tool call
 */

import * as path from "node:path";
import type { StreamEvent } from "@co/contracts";

interface StreamContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
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

const SUMMARY_MAX = 80;

function pickString(input: unknown, key: string): string | null {
  if (input && typeof input === "object" && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function summarizeToolUse(name: string, input: unknown): string {
  switch (name) {
    case "Bash": {
      const cmd = pickString(input, "command");
      return cmd ? truncate(cmd, SUMMARY_MAX) : name;
    }
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit": {
      const fp = pickString(input, "file_path");
      return fp ? path.basename(fp) : name;
    }
    case "Grep":
    case "Glob": {
      const pat = pickString(input, "pattern");
      return pat ? truncate(pat, SUMMARY_MAX) : name;
    }
    default:
      return name;
  }
}

function parseJson(line: string): StreamLine | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as StreamLine;
  } catch {
    return null;
  }
}

/**
 * Parse a single stream-json line into a structured StreamEvent.
 *
 * Assistant lines may contain multiple content blocks; the first
 * non-empty block wins (text > thinking > tool_use), since the worker
 * activity stream is a low-rate summary. Callers that need every block
 * should switch to a streaming parser.
 *
 * Returns null for empty/unparseable lines.
 */
export function parseStreamLine(line: string): StreamEvent | null {
  const parsed = parseJson(line);
  if (!parsed) return null;

  if (parsed.type === "assistant") {
    const content = (parsed as StreamAssistant).message?.content;
    if (!content || content.length === 0) return { kind: "other" };

    const texts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        texts.push(block.text);
      }
    }
    if (texts.length > 0) {
      return { kind: "text", text: texts.join("") };
    }
    for (const block of content) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        return {
          kind: "tool_use",
          tool: block.name,
          summary: summarizeToolUse(block.name, block.input),
        };
      }
    }
    for (const block of content) {
      if (block.type === "thinking") {
        return { kind: "thinking" };
      }
    }
    return { kind: "other" };
  }

  if (parsed.type === "result") {
    const r = parsed as StreamResult;
    return {
      kind: "result",
      text: r.result ?? null,
      is_error: Boolean(r.is_error),
    };
  }

  if (parsed.type === "system") return { kind: "system" };
  return { kind: "other" };
}

/**
 * Parse a single stream-json line and extract visible assistant text.
 * Returns null for non-assistant messages or assistant messages with
 * no text content (thinking-only, tool-use-only).
 */
export function extractAssistantText(line: string): string | null {
  const event = parseStreamLine(line);
  if (event?.kind === "text") return event.text;
  return null;
}

/**
 * Parse a stream-json line and return the result text for "result" type
 * messages. Returns null for non-result messages.
 */
export function extractResultText(line: string): string | null {
  const event = parseStreamLine(line);
  if (event?.kind === "result") return event.text;
  return null;
}
