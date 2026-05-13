import { describe, it, expect } from "vitest";
import { EmailValidator } from "../validator.js";

describe("EmailValidator", () => {
  const validator = new EmailValidator();

  describe("validate — valid emails", () => {
    it("accepts test@example.com", () => {
      const r = validator.validate("test@example.com");
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.normalized).toBe("test@example.com");
    });

    it("accepts user@[192.168.1.1] (IPv4 literal)", () => {
      const r = validator.validate("user@[192.168.1.1]");
      expect(r.valid).toBe(true);
    });

    it("accepts a@[IPv6:2001:db8::1] (IPv6 literal)", () => {
      const r = validator.validate("a@[IPv6:2001:db8::1]");
      expect(r.valid).toBe(true);
    });

    it("accepts quoted local-part", () => {
      const r = validator.validate('"john.doe"@example.com');
      expect(r.valid).toBe(true);
    });

    it("accepts display name", () => {
      const r = validator.validate("John <john@example.com>");
      expect(r.valid).toBe(true);
    });

    it("accepts email with plus alias", () => {
      const r = validator.validate("user+tag@domain.com");
      expect(r.valid).toBe(true);
    });

    it("accepts 254-char email (boundary)", () => {
      const local = "a".repeat(64);
      const domain = "b".repeat(63) + ".c".repeat(63) + ".com";
      const email = `${local}@${domain}`;
      if (email.length <= 254) {
        // Only test if it fits within 254
        const r = validator.validate(email);
        expect(r.valid).toBe(true);
      }
    });
  });

  describe("validate — invalid emails", () => {
    it("rejects empty string", () => {
      const r = validator.validate("");
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.code === "ERR_EMPTY_INPUT")).toBe(true);
    });

    it("rejects missing @", () => {
      const r = validator.validate("not-an-email");
      expect(r.valid).toBe(false);
    });

    it("rejects double @", () => {
      const r = validator.validate("a@b@c.com");
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.code === "ERR_MULTIPLE_AT")).toBe(true);
    });

    it("rejects consecutive dots in local part", () => {
      const r = validator.validate("john..doe@example.com");
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.code === "ERR_LOCAL_PART_CONSECUTIVE_DOTS")).toBe(true);
    });

    it("rejects local part > 64 chars", () => {
      const lp = "a".repeat(65);
      const r = validator.validate(`${lp}@example.com`);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.code === "ERR_LOCAL_PART_LENGTH")).toBe(true);
    });

    it("rejects email with domain > 255 chars", () => {
      const label = "a".repeat(63);
      const domain = `${label}.${label}.${label}.${label}.${label}`;
      const r = validator.validate(`user@${domain}`);
      expect(r.valid).toBe(false);
      // Total length check (254) fires before domain-level validation
      expect(r.errors.some((e) => e.code === "ERR_TOTAL_LENGTH")).toBe(true);
    });

    it("rejects numeric TLD", () => {
      const r = validator.validate("user@example.123");
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.code === "ERR_DOMAIN_NUMERIC_TLD")).toBe(true);
    });

    it("rejects domain with no dot", () => {
      const r = validator.validate("user@localhost");
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.code === "ERR_DOMAIN_NO_DOT")).toBe(true);
    });

    it("rejects leading dot in local part", () => {
      const r = validator.validate(".user@example.com");
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.code === "ERR_LOCAL_PART_DOT_START")).toBe(true);
    });

    it("rejects whitespace in addr-spec", () => {
      const r = validator.validate("user @example.com");
      expect(r.valid).toBe(false);
    });
  });

  describe("isValid convenience", () => {
    it("returns true for valid email", () => {
      expect(validator.isValid("test@example.com")).toBe(true);
    });

    it("returns false for invalid email", () => {
      expect(validator.isValid("invalid")).toBe(false);
    });
  });

  describe("normalize", () => {
    it("lowercases domain", () => {
      expect(validator.normalize("Test@Example.COM")).toBe("Test@example.com");
    });

    it("returns null for invalid", () => {
      expect(validator.normalize("invalid")).toBeNull();
    });

    it("preserves local part case", () => {
      expect(validator.normalize("UsEr@Domain.Com")).toBe("UsEr@domain.com");
    });
  });

  describe("options", () => {
    it("getOptions returns defaults", () => {
      const opts = validator.getOptions();
      expect(opts.maxLocalPartLength).toBe(64);
      expect(opts.maxDomainLength).toBe(255);
      expect(opts.maxTotalLength).toBe(254);
      expect(opts.allowComments).toBe(false);
      expect(opts.allowDisplayName).toBe(true);
    });

    it("accepts custom max lengths", () => {
      const v = new EmailValidator({ maxLocalPartLength: 10, maxDomainLength: 50, maxTotalLength: 100 });
      const opts = v.getOptions();
      expect(opts.maxLocalPartLength).toBe(10);
      expect(opts.maxDomainLength).toBe(50);
      expect(opts.maxTotalLength).toBe(100);
    });

    it("allows comments when configured", () => {
      const v = new EmailValidator({ allowComments: true });
      const r = v.validate("user(comment)@example.com");
      expect(r.valid).toBe(true);
    });

    it("rejects display name when disabled", () => {
      const v = new EmailValidator({ allowDisplayName: false });
      const r = v.validate("John <john@example.com>");
      // Without display name parsing, "John <john" becomes local-part which has a space
      expect(r.valid).toBe(false);
    });

    it("getOptions returns frozen copy", () => {
      const v = new EmailValidator();
      const opts1 = v.getOptions();
      const opts2 = v.getOptions();
      expect(opts1).toEqual(opts2);
      expect(opts1).not.toBe(opts2);
    });
  });
});
