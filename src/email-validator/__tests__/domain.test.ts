import { describe, it, expect } from "vitest";
import { validateDomain } from "../domain.js";

describe("validateDomain", () => {
  describe("valid hostnames", () => {
    it("accepts example.com", () => {
      expect(validateDomain("example.com", false, false)).toEqual([]);
    });

    it("accepts subdomain", () => {
      expect(validateDomain("mail.example.com", false, false)).toEqual([]);
    });

    it("accepts multi-level domain", () => {
      expect(validateDomain("a.b.c.d.e.com", false, false)).toEqual([]);
    });

    it("accepts hyphen in middle of label", () => {
      expect(validateDomain("my-domain.com", false, false)).toEqual([]);
    });

    it("accepts digits in labels", () => {
      expect(validateDomain("example123.com", false, false)).toEqual([]);
    });

    it("accepts single-char labels", () => {
      expect(validateDomain("a.b", false, false)).toEqual([]);
    });

    it("accepts 63-char label (boundary)", () => {
      const label = "a".repeat(63);
      expect(validateDomain(`${label}.com`, false, false)).toEqual([]);
    });
  });

  describe("valid IP literals", () => {
    it("accepts IPv4 literal", () => {
      expect(validateDomain("192.168.1.1", true, false)).toEqual([]);
    });

    it("accepts IPv4 with boundary values", () => {
      expect(validateDomain("0.0.0.0", true, false)).toEqual([]);
      expect(validateDomain("255.255.255.255", true, false)).toEqual([]);
    });

    it("accepts IPv6 literal", () => {
      expect(validateDomain("2001:db8::1", false, true)).toEqual([]);
    });

    it("accepts full IPv6", () => {
      expect(validateDomain("2001:0db8:0000:0000:0000:0000:0000:0001", false, true)).toEqual([]);
    });

    it("accepts IPv6 loopback", () => {
      expect(validateDomain("::1", false, true)).toEqual([]);
    });

    it("accepts IPv6 fe80", () => {
      expect(validateDomain("fe80::1", false, true)).toEqual([]);
    });
  });

  describe("hostname label errors", () => {
    it("rejects label starting with hyphen", () => {
      const errors = validateDomain("example.-domain.com", false, false);
      expect(errors.some((e) => e.code === "ERR_DOMAIN_LABEL_HYPHEN_START")).toBe(true);
    });

    it("rejects label ending with hyphen", () => {
      const errors = validateDomain("example.domain-.com", false, false);
      expect(errors.some((e) => e.code === "ERR_DOMAIN_LABEL_HYPHEN_END")).toBe(true);
    });

    it("rejects empty label (consecutive dots)", () => {
      const errors = validateDomain("example..com", false, false);
      expect(errors.some((e) => e.code === "ERR_DOMAIN_LABEL_EMPTY")).toBe(true);
    });

    it("rejects label exceeding 63 chars", () => {
      const label = "a".repeat(64);
      const errors = validateDomain(`${label}.com`, false, false);
      expect(errors.some((e) => e.code === "ERR_DOMAIN_LABEL_LENGTH")).toBe(true);
    });

    it("rejects invalid char in label", () => {
      const errors = validateDomain("example.c_m.com", false, false);
      expect(errors.some((e) => e.code === "ERR_DOMAIN_INVALID_CHAR")).toBe(true);
    });

    it("rejects domain with no dot", () => {
      const errors = validateDomain("localhost", false, false);
      expect(errors.some((e) => e.code === "ERR_DOMAIN_NO_DOT")).toBe(true);
    });

    it("rejects numeric TLD", () => {
      const errors = validateDomain("example.123", false, false);
      expect(errors.some((e) => e.code === "ERR_DOMAIN_NUMERIC_TLD")).toBe(true);
    });
  });

  describe("length errors", () => {
    it("rejects empty domain", () => {
      const errors = validateDomain("", false, false);
      expect(errors.some((e) => e.code === "ERR_DOMAIN_EMPTY")).toBe(true);
    });

    it("rejects domain exceeding 255 chars", () => {
      const label = "a".repeat(63);
      const domain = `${label}.${label}.${label}.${label}.${label}`;
      // That's ~319 chars, > 255
      const errors = validateDomain(domain, false, false, 255);
      expect(errors.some((e) => e.code === "ERR_DOMAIN_LENGTH")).toBe(true);
    });

    it("accepts with custom max domain length", () => {
      const domain = "a".repeat(10) + ".b";
      const errors = validateDomain(domain, false, false, 100);
      expect(errors.filter((e) => e.code === "ERR_DOMAIN_LENGTH")).toEqual([]);
    });
  });

  describe("IPv4 literal errors", () => {
    it("rejects invalid octet value (>255)", () => {
      const errors = validateDomain("256.1.1.1", true, false);
      expect(errors.some((e) => e.code === "ERR_IPV4_INVALID")).toBe(true);
    });

    it("rejects wrong number of octets", () => {
      const errors = validateDomain("1.2.3", true, false);
      expect(errors.some((e) => e.code === "ERR_IPV4_INVALID")).toBe(true);
    });

    it("rejects non-numeric octet", () => {
      const errors = validateDomain("abc.1.1.1", true, false);
      expect(errors.some((e) => e.code === "ERR_IPV4_INVALID")).toBe(true);
    });
  });

  describe("IPv6 literal errors", () => {
    it("rejects empty IPv6", () => {
      const errors = validateDomain("", false, true);
      // Empty domain is caught by the general empty check, which takes precedence
      expect(errors.some((e) => e.code === "ERR_DOMAIN_EMPTY")).toBe(true);
    });

    it("rejects invalid hex chars", () => {
      const errors = validateDomain("gggg::1", false, true);
      expect(errors.some((e) => e.code === "ERR_IPV6_INVALID")).toBe(true);
    });

    it("rejects too many segments", () => {
      const errors = validateDomain("1:2:3:4:5:6:7:8:9", false, true);
      expect(errors.some((e) => e.code === "ERR_IPV6_INVALID")).toBe(true);
    });
  });
});
