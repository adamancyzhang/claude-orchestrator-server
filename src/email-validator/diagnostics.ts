import type { ValidationError } from "./types.js";

export const ErrorCodes: Record<string, string> = {
  ERR_EMPTY_INPUT: "Input is empty or whitespace-only",
  ERR_TOTAL_LENGTH: "Address exceeds maximum length",
  ERR_NO_AT_SIGN: "No '@' character found",
  ERR_MULTIPLE_AT: "Multiple '@' characters found",
  ERR_LOCAL_PART_EMPTY: "Local part is empty",
  ERR_LOCAL_PART_LENGTH: "Local part exceeds maximum length",
  ERR_LOCAL_PART_INVALID_CHAR: "Invalid character in local part",
  ERR_LOCAL_PART_DOT_START: "Local part starts with '.'",
  ERR_LOCAL_PART_DOT_END: "Local part ends with '.'",
  ERR_LOCAL_PART_CONSECUTIVE_DOTS: "Consecutive '.' characters in local part",
  ERR_UNBALANCED_QUOTES: "Unbalanced double-quote in quoted local part",
  ERR_DOMAIN_EMPTY: "Domain is empty",
  ERR_DOMAIN_LENGTH: "Domain exceeds maximum length",
  ERR_DOMAIN_LABEL_EMPTY: "Domain label is empty",
  ERR_DOMAIN_LABEL_LENGTH: "Domain label exceeds maximum length",
  ERR_DOMAIN_LABEL_HYPHEN_START: "Domain label starts with '-'",
  ERR_DOMAIN_LABEL_HYPHEN_END: "Domain label ends with '-'",
  ERR_DOMAIN_INVALID_CHAR: "Invalid character in domain",
  ERR_DOMAIN_NO_DOT: "Domain has no dot (TLD required)",
  ERR_DOMAIN_NUMERIC_TLD: "Top-level domain is all-numeric",
  ERR_IPV4_INVALID: "IPv4 literal is malformed",
  ERR_IPV6_INVALID: "IPv6 literal is malformed",
  ERR_COMMENTS_NOT_ALLOWED: "Comments not allowed by configuration",
};

const PLACEHOLDER_RE = /\{(\w+)\}/g;

export function makeError(code: string, position?: number, extra?: Record<string, string>): ValidationError {
  let message = ErrorCodes[code] ?? code;
  if (extra) {
    message = message.replace(PLACEHOLDER_RE, (_match, key) => extra[key] ?? `{${key}}`);
  }
  return { code, message, position: position ?? -1 };
}
