import type { EmailParseResult, EmailValidatorOptions, ValidationError } from "./types.js";
import { makeError } from "./diagnostics.js";

export type ParseResult =
  | { ok: true; value: EmailParseResult }
  | { ok: false; error: ValidationError };

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

function findAddrSpecBoundary(email: string): { addrSpec: string; displayName: string | null } {
  const lastClose = email.lastIndexOf(">");
  if (lastClose === -1) return { addrSpec: email, displayName: null };

  const openIdx = email.lastIndexOf("<", lastClose);
  if (openIdx === -1) return { addrSpec: email, displayName: null };

  const afterClose = email.slice(lastClose + 1);
  if (afterClose.trim().length > 0) return { addrSpec: email, displayName: null };

  const addrSpec = email.slice(openIdx + 1, lastClose);
  const displayName = email.slice(0, openIdx).trim();

  return {
    addrSpec,
    displayName: displayName.length > 0 ? displayName : null,
  };
}

function stripComments(input: string): string {
  const result: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\" && i + 1 < input.length) {
      result.push(ch, input[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '"') {
      const end = input.indexOf('"', i + 1);
      if (end === -1) {
        result.push(input.slice(i));
        break;
      }
      result.push(input.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (ch === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < input.length && depth > 0) {
        if (input[j] === "(") depth++;
        else if (input[j] === ")") depth--;
        if (depth > 0) j++;
      }
      if (depth === 0) {
        i = j + 1;
        continue;
      }
    }
    result.push(ch);
    i++;
  }
  return result.join("");
}

export function parseEmail(email: string, options: EmailValidatorOptions): ParseResult {
  const trimmed = email.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: makeError("ERR_EMPTY_INPUT") };
  }

  const maxTotal = options.maxTotalLength ?? 254;
  if (trimmed.length > maxTotal) {
    return { ok: false, error: makeError("ERR_TOTAL_LENGTH") };
  }

  let working = trimmed;
  let displayName: string | null = null;

  if (options.allowDisplayName !== false) {
    const resolved = findAddrSpecBoundary(working);
    working = resolved.addrSpec;
    displayName = resolved.displayName;
  }

  if (options.allowComments === true) {
    working = stripComments(working);
  } else {
    for (let i = 0; i < working.length; i++) {
      if (working[i] === "(") {
        return { ok: false, error: makeError("ERR_COMMENTS_NOT_ALLOWED", i) };
      }
    }
  }

  const atIndex = working.lastIndexOf("@");
  if (atIndex === -1) {
    return { ok: false, error: makeError("ERR_NO_AT_SIGN") };
  }
  if (working.indexOf("@") !== atIndex) {
    return { ok: false, error: makeError("ERR_MULTIPLE_AT") };
  }

  const localPart = working.slice(0, atIndex);
  const domainRaw = working.slice(atIndex + 1);

  let domain = domainRaw;
  let isIpLiteral = false;
  let isIPv6 = false;

  if (domainRaw.startsWith("[") && domainRaw.endsWith("]")) {
    isIpLiteral = true;
    domain = domainRaw.slice(1, -1);
    if (domain.toUpperCase().startsWith("IPV6:")) {
      isIPv6 = true;
      domain = domain.slice(5);
    }
  }

  return {
    ok: true,
    value: {
      localPart,
      domain,
      displayName,
      isIpLiteral,
      isIPv6,
    },
  };
}
