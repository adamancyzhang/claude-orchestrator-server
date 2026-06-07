import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  sanitizeString,
  matchesPattern,
  isValidLength,
  isSafeIdentifier,
  isValidPath,
  isValidVersion,
  truncateString,
  isPayloadSizeValid,
  validateJsonStructure,
} from "../../src/security/input-validation.js";

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes quotes and slash", () => {
    expect(escapeHtml('"\'/')).toBe("&quot;&#x27;&#x2F;");
  });

  it("returns safe strings unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes all dangerous characters in combination", () => {
    expect(escapeHtml("<img src=x onerror=alert('xss')>")).toBe(
      "&lt;img src=x onerror=alert(&#x27;xss&#x27;)&gt;"
    );
  });
});

describe("sanitizeString", () => {
  it("escapes HTML in input", () => {
    expect(sanitizeString("<b>bold</b>")).toBe("&lt;b&gt;bold&lt;&#x2F;b&gt;");
  });

  it("passes through safe strings", () => {
    expect(sanitizeString("normal text")).toBe("normal text");
  });
});

describe("matchesPattern", () => {
  it("returns true for matching pattern", () => {
    expect(matchesPattern("abc123", /^[a-z]+\d+$/)).toBe(true);
  });

  it("returns false for non-matching pattern", () => {
    expect(matchesPattern("abc", /^\d+$/)).toBe(false);
  });
});

describe("isValidLength", () => {
  it("returns true for valid length", () => {
    expect(isValidLength("abc", 1, 5)).toBe(true);
  });

  it("returns true at exact min", () => {
    expect(isValidLength("a", 1, 5)).toBe(true);
  });

  it("returns true at exact max", () => {
    expect(isValidLength("abcde", 1, 5)).toBe(true);
  });

  it("returns false when too short", () => {
    expect(isValidLength("", 1, 5)).toBe(false);
  });

  it("returns false when too long", () => {
    expect(isValidLength("abcdef", 1, 5)).toBe(false);
  });
});

describe("isSafeIdentifier", () => {
  it("accepts alphanumeric", () => {
    expect(isSafeIdentifier("abc123")).toBe(true);
  });

  it("accepts dots, dashes, underscores", () => {
    expect(isSafeIdentifier("my-file_v2.test")).toBe(true);
  });

  it("rejects spaces", () => {
    expect(isSafeIdentifier("my file")).toBe(false);
  });

  it("rejects special characters", () => {
    expect(isSafeIdentifier("file<script>")).toBe(false);
  });
});

describe("isValidPath", () => {
  it("accepts valid paths", () => {
    expect(isValidPath("/api/state")).toBe(true);
    expect(isValidPath("/")).toBe(true);
    expect(isValidPath("/a/b/c")).toBe(true);
  });

  it("rejects paths without leading slash", () => {
    expect(isValidPath("api/state")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(isValidPath("/api/../etc/passwd")).toBe(false);
  });

  it("rejects paths with query strings", () => {
    expect(isValidPath("/api?key=value")).toBe(false);
  });
});

describe("isValidVersion", () => {
  it("accepts valid semver", () => {
    expect(isValidVersion("1.0.0")).toBe(true);
    expect(isValidVersion("0.1.0-beta.1")).toBe(true);
    expect(isValidVersion("1.0.0+build.123")).toBe(true);
  });

  it("rejects invalid versions", () => {
    expect(isValidVersion("v1.0.0")).toBe(false);
    expect(isValidVersion("1.0")).toBe(false);
    expect(isValidVersion("not-a-version")).toBe(false);
  });
});

describe("truncateString", () => {
  it("returns original if under limit", () => {
    expect(truncateString("hello", 10)).toBe("hello");
  });

  it("truncates if over limit", () => {
    expect(truncateString("hello world", 5)).toBe("hello");
  });

  it("returns original at exact limit", () => {
    expect(truncateString("hello", 5)).toBe("hello");
  });
});

describe("isPayloadSizeValid", () => {
  it("returns true for small payload", () => {
    expect(isPayloadSizeValid("hello", 1024)).toBe(true);
  });

  it("returns false for oversized payload", () => {
    expect(isPayloadSizeValid("a".repeat(2048), 1024)).toBe(false);
  });

  it("returns true at exact limit", () => {
    expect(isPayloadSizeValid("a".repeat(1024), 1024)).toBe(true);
  });
});

describe("validateJsonStructure", () => {
  it("accepts valid simple object", () => {
    const result = validateJsonStructure({ name: "test", value: 123 });
    expect(result.valid).toBe(true);
  });

  it("rejects excessive nesting", () => {
    const deep: Record<string, unknown> = { a: 1 };
    let current = deep;
    for (let i = 0; i < 10; i++) {
      current = { nested: current };
    }
    const result = validateJsonStructure(current, { maxDepth: 5 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("nesting depth");
  });

  it("rejects too many keys", () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      obj[`key${i}`] = i;
    }
    const result = validateJsonStructure(obj, { maxObjectKeys: 50 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("keys");
  });

  it("rejects invalid key names", () => {
    const result = validateJsonStructure({ "key<script>": 1 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid JSON key");
  });

  it("accepts valid arrays", () => {
    const result = validateJsonStructure([1, 2, 3]);
    expect(result.valid).toBe(true);
  });

  it("rejects oversized arrays", () => {
    const result = validateJsonStructure(new Array(100).fill(1), { maxObjectKeys: 10 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("elements");
  });

  it("accepts null values", () => {
    const result = validateJsonStructure(null);
    expect(result.valid).toBe(true);
  });

  it("accepts primitives", () => {
    expect(validateJsonStructure("string").valid).toBe(true);
    expect(validateJsonStructure(42).valid).toBe(true);
    expect(validateJsonStructure(true).valid).toBe(true);
  });
});
