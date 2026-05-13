import type { ValidationError } from "./types.js";
import { makeError } from "./diagnostics.js";

const DOT_ATOM_REGEX = /^[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~.]+$/;
const ATEXT_REGEX = /^[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~]+$/;

export function validateLocalPart(localPart: string, maxLength?: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const max = maxLength ?? 64;

  if (localPart.length === 0) {
    errors.push(makeError("ERR_LOCAL_PART_EMPTY", 0));
    return errors;
  }

  if (localPart.length > max) {
    errors.push(makeError("ERR_LOCAL_PART_LENGTH", 0));
  }

  if (localPart.startsWith('"') && localPart.endsWith('"') && localPart.length >= 2) {
    validateQuotedString(localPart, errors);
  } else {
    validateDotAtom(localPart, errors);
  }

  return errors;
}

function validateDotAtom(localPart: string, errors: ValidationError[]): void {
  if (!DOT_ATOM_REGEX.test(localPart)) {
    const badIdx = findFirstInvalidChar(localPart);
    errors.push(makeError("ERR_LOCAL_PART_INVALID_CHAR", badIdx));
    return;
  }

  if (localPart.startsWith(".")) {
    errors.push(makeError("ERR_LOCAL_PART_DOT_START", 0));
  }

  if (localPart.endsWith(".")) {
    errors.push(makeError("ERR_LOCAL_PART_DOT_END", localPart.length - 1));
  }

  if (localPart.includes("..")) {
    const pos = localPart.indexOf("..");
    errors.push(makeError("ERR_LOCAL_PART_CONSECUTIVE_DOTS", pos));
  }
}

function validateQuotedString(quoted: string, errors: ValidationError[]): void {
  const inner = quoted.slice(1, -1);

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"') {
      errors.push(makeError("ERR_UNBALANCED_QUOTES", i + 1));
      return;
    }
    if (ch === "\r" || ch === "\n") {
      errors.push(makeError("ERR_LOCAL_PART_INVALID_CHAR", i + 1));
      return;
    }
  }
}

function findFirstInvalidChar(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const segment = s[i];
    if (
      !ATEXT_REGEX.test(segment) &&
      segment !== "."
    ) {
      return i;
    }
  }
  return -1;
}
