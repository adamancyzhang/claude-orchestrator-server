import { describe, it, expect } from "vitest";
import { validateLocalPart } from "../local-part.js";

describe("validateLocalPart", () => {
  describe("valid dot-atom", () => {
    it("accepts simple alphanumeric", () => {
      expect(validateLocalPart("user")).toEqual([]);
    });

    it("accepts single character", () => {
      expect(validateLocalPart("a")).toEqual([]);
    });

    it("accepts all allowed special characters", () => {
      expect(validateLocalPart("a!#$%&'*+-/=?^_`{|}~z")).toEqual([]);
    });

    it("accepts dot in middle", () => {
      expect(validateLocalPart("first.last")).toEqual([]);
    });

    it("accepts multiple dots", () => {
      expect(validateLocalPart("a.b.c")).toEqual([]);
    });

    it("accepts digits", () => {
      expect(validateLocalPart("user123")).toEqual([]);
    });

    it("accepts plus sign (common alias)", () => {
      expect(validateLocalPart("user+tag")).toEqual([]);
    });

    it("accepts 64-char local part", () => {
      const lp = "a".repeat(64);
      expect(validateLocalPart(lp)).toEqual([]);
    });
  });

  describe("valid quoted strings", () => {
    it("accepts quoted string with spaces", () => {
      expect(validateLocalPart('"hello world"')).toEqual([]);
    });

    it("accepts quoted string with special chars", () => {
      expect(validateLocalPart('"john@doe"')).toEqual([]);
    });

    it("accepts quoted string with escaped chars", () => {
      expect(validateLocalPart('"escaped \\" quote"')).toEqual([]);
    });

    it("accepts empty quoted string", () => {
      expect(validateLocalPart('""')).toEqual([]);
    });
  });

  describe("dot-atom errors", () => {
    it("rejects leading dot", () => {
      const errors = validateLocalPart(".user");
      expect(errors.some((e) => e.code === "ERR_LOCAL_PART_DOT_START")).toBe(true);
    });

    it("rejects trailing dot", () => {
      const errors = validateLocalPart("user.");
      expect(errors.some((e) => e.code === "ERR_LOCAL_PART_DOT_END")).toBe(true);
    });

    it("rejects consecutive dots", () => {
      const errors = validateLocalPart("user..name");
      expect(errors.some((e) => e.code === "ERR_LOCAL_PART_CONSECUTIVE_DOTS")).toBe(true);
    });

    it("rejects invalid char (space)", () => {
      const errors = validateLocalPart("user name");
      expect(errors.some((e) => e.code === "ERR_LOCAL_PART_INVALID_CHAR")).toBe(true);
    });

    it("rejects invalid char (angle bracket)", () => {
      const errors = validateLocalPart("<user>");
      expect(errors.some((e) => e.code === "ERR_LOCAL_PART_INVALID_CHAR")).toBe(true);
    });
  });

  describe("length errors", () => {
    it("rejects empty local part", () => {
      const errors = validateLocalPart("");
      expect(errors.some((e) => e.code === "ERR_LOCAL_PART_EMPTY")).toBe(true);
    });

    it("rejects local part exceeding default 64 chars", () => {
      const lp = "a".repeat(65);
      const errors = validateLocalPart(lp);
      expect(errors.some((e) => e.code === "ERR_LOCAL_PART_LENGTH")).toBe(true);
    });

    it("accepts with custom max length", () => {
      const lp = "a".repeat(10);
      const errors = validateLocalPart(lp, 10);
      expect(errors).toEqual([]);
    });

    it("rejects with custom max length exceeded", () => {
      const lp = "a".repeat(11);
      const errors = validateLocalPart(lp, 10);
      expect(errors.some((e) => e.code === "ERR_LOCAL_PART_LENGTH")).toBe(true);
    });
  });

  describe("quoted string errors", () => {
    it("rejects unbalanced quotes", () => {
      const errors = validateLocalPart('"unbalanced');
      // Falls through to dot-atom validation since it doesn't start+end with quotes
      expect(errors.some((e) => e.code === "ERR_LOCAL_PART_INVALID_CHAR")).toBe(true);
    });

    it("rejects quote in middle of quoted string", () => {
      const errors = validateLocalPart('"hello"world"');
      expect(errors.some((e) => e.code === "ERR_UNBALANCED_QUOTES")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("multiple errors for dot-only local part", () => {
      const errors = validateLocalPart(".");
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });

    it("multiple errors for double-dot-only", () => {
      const errors = validateLocalPart("..");
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });
  });
});
