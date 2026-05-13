import type { ValidationError } from "./types.js";
import { makeError } from "./diagnostics.js";

const HOSTNAME_LABEL_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const NUMERIC_RE = /^\d+$/;

export function validateDomain(
  domain: string,
  isIpLiteral: boolean,
  isIPv6: boolean,
  maxLength?: number,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const max = maxLength ?? 255;

  if (domain.length === 0) {
    errors.push(makeError("ERR_DOMAIN_EMPTY"));
    return errors;
  }

  if (domain.length > max) {
    errors.push(makeError("ERR_DOMAIN_LENGTH"));
  }

  if (isIPv6) {
    validateIPv6Literal(domain, errors);
  } else if (isIpLiteral) {
    validateIPv4Literal(domain, errors);
  } else {
    validateHostname(domain, errors);
  }

  return errors;
}

function validateHostname(domain: string, errors: ValidationError[]): void {
  const labels = domain.split(".");

  if (labels.length < 2) {
    errors.push(makeError("ERR_DOMAIN_NO_DOT"));
  }

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label.length === 0) {
      errors.push(makeError("ERR_DOMAIN_LABEL_EMPTY"));
      continue;
    }
    if (label.length > 63) {
      errors.push(makeError("ERR_DOMAIN_LABEL_LENGTH"));
    }
    if (label.startsWith("-")) {
      errors.push(makeError("ERR_DOMAIN_LABEL_HYPHEN_START"));
    }
    if (label.endsWith("-")) {
      errors.push(makeError("ERR_DOMAIN_LABEL_HYPHEN_END"));
    }
    if (!HOSTNAME_LABEL_RE.test(label)) {
      const badIdx = findFirstInvalidHostnameChar(label);
      errors.push(makeError("ERR_DOMAIN_INVALID_CHAR", badIdx));
    }
  }

  const tld = labels[labels.length - 1];
  if (tld && tld.length > 0 && NUMERIC_RE.test(tld)) {
    errors.push(makeError("ERR_DOMAIN_NUMERIC_TLD"));
  }
}

function validateIPv4Literal(ip: string, errors: ValidationError[]): void {
  const octets = ip.split(".");
  if (octets.length !== 4) {
    errors.push(makeError("ERR_IPV4_INVALID"));
    return;
  }
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) {
      errors.push(makeError("ERR_IPV4_INVALID"));
      return;
    }
    const num = parseInt(octet, 10);
    if (num < 0 || num > 255) {
      errors.push(makeError("ERR_IPV4_INVALID"));
      return;
    }
  }
}

function validateIPv6Literal(ip: string, errors: ValidationError[]): void {
  if (ip.length === 0) {
    errors.push(makeError("ERR_IPV6_INVALID"));
    return;
  }

  const hexRe = /^[0-9a-fA-F]{1,4}$/;

  const doubleColonIdx = ip.indexOf("::");
  if (doubleColonIdx !== -1) {
    const before = doubleColonIdx > 0 ? ip.slice(0, doubleColonIdx).split(":") : [];
    const after = doubleColonIdx + 2 < ip.length ? ip.slice(doubleColonIdx + 2).split(":") : [];
    const parts = [...before, ...after];
    if (parts.length > 7) {
      errors.push(makeError("ERR_IPV6_INVALID"));
      return;
    }
    for (const part of parts) {
      if (part !== "" && !hexRe.test(part)) {
        errors.push(makeError("ERR_IPV6_INVALID"));
        return;
      }
    }
    return;
  }

  const parts = ip.split(":");
  if (parts.length !== 8) {
    errors.push(makeError("ERR_IPV6_INVALID"));
    return;
  }
  for (const part of parts) {
    if (!hexRe.test(part)) {
      errors.push(makeError("ERR_IPV6_INVALID"));
      return;
    }
  }
}

function findFirstInvalidHostnameChar(label: string): number {
  for (let i = 0; i < label.length; i++) {
    const ch = label[i];
    const isAlnum = (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9");
    const isHyphen = ch === "-";
    if (!isAlnum && !isHyphen) {
      return i;
    }
  }
  return -1;
}
