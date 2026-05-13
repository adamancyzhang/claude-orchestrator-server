import { describe, it, expect } from "vitest";
import { parseEmail } from "../parser.js";
import type { EmailValidatorOptions } from "../types.js";

const defaults: EmailValidatorOptions = { allowDisplayName: true, allowComments: false };

describe("parseEmail", () => {
  describe("simple addr-spec", () => {
    it("parses user@domain.com", () => {
      const r = parseEmail("user@domain.com", defaults);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.localPart).toBe("user");
        expect(r.value.domain).toBe("domain.com");
        expect(r.value.displayName).toBeNull();
        expect(r.value.isIpLiteral).toBe(false);
        expect(r.value.isIPv6).toBe(false);
      }
    });

    it("parses a@b.c (minimal)", () => {
      const r = parseEmail("a@b.c", defaults);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.localPart).toBe("a");
        expect(r.value.domain).toBe("b.c");
      }
    });

    it("parses addr-spec with subdomain", () => {
      const r = parseEmail("user@mail.example.co.uk", defaults);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.localPart).toBe("user");
        expect(r.value.domain).toBe("mail.example.co.uk");
      }
    });
  });

  describe("display name", () => {
    it("extracts display name from angle-bracket form", () => {
      const r = parseEmail("John Doe <john@example.com>", defaults);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.localPart).toBe("john");
        expect(r.value.domain).toBe("example.com");
        expect(r.value.displayName).toBe("John Doe");
      }
    });

    it("returns null display name when not present", () => {
      const r = parseEmail("user@domain.com", defaults);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.displayName).toBeNull();
      }
    });

    it("ignores display name when disabled", () => {
      const r = parseEmail("John <john@example.com>", { allowDisplayName: false });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.localPart).toBe("John <john");
        expect(r.value.domain).toBe("example.com>");
      }
    });
  });

  describe("comments", () => {
    it("strips comments when enabled", () => {
      const r = parseEmail("user(comment)@domain.com", { allowComments: true });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.localPart).toBe("user");
        expect(r.value.domain).toBe("domain.com");
      }
    });

    it("rejects comments when disabled", () => {
      const r = parseEmail("user(comment)@domain.com", { allowComments: false });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("ERR_COMMENTS_NOT_ALLOWED");
      }
    });

    it("strips multiple comments", () => {
      const r = parseEmail("(hello)user(world)@domain.com", { allowComments: true });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.localPart).toBe("user");
      }
    });

    it("strips nested comments", () => {
      const r = parseEmail("user((nested))@domain.com", { allowComments: true });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.localPart).toBe("user");
      }
    });
  });

  describe("IP literals", () => {
    it("detects IPv4 literal", () => {
      const r = parseEmail("user@[192.168.1.1]", defaults);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.domain).toBe("192.168.1.1");
        expect(r.value.isIpLiteral).toBe(true);
        expect(r.value.isIPv6).toBe(false);
      }
    });

    it("detects IPv6 literal", () => {
      const r = parseEmail("user@[IPv6:2001:db8::1]", defaults);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.domain).toBe("2001:db8::1");
        expect(r.value.isIpLiteral).toBe(true);
        expect(r.value.isIPv6).toBe(true);
      }
    });

    it("detects IPv6 literal case-insensitively", () => {
      const r = parseEmail("user@[ipv6:fe80::1]", defaults);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.isIPv6).toBe(true);
        expect(r.value.domain).toBe("fe80::1");
      }
    });
  });

  describe("error cases", () => {
    it("ERR_EMPTY_INPUT for empty string", () => {
      const r = parseEmail("", defaults);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("ERR_EMPTY_INPUT");
    });

    it("ERR_EMPTY_INPUT for whitespace-only", () => {
      const r = parseEmail("   ", defaults);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("ERR_EMPTY_INPUT");
    });

    it("ERR_TOTAL_LENGTH for exceeding max", () => {
      const long = "a".repeat(255) + "@b.c";
      const r = parseEmail(long, { maxTotalLength: 254 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("ERR_TOTAL_LENGTH");
    });

    it("ERR_NO_AT_SIGN when missing @", () => {
      const r = parseEmail("not-an-email", defaults);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("ERR_NO_AT_SIGN");
    });

    it("ERR_MULTIPLE_AT for double @", () => {
      const r = parseEmail("a@b@c.com", defaults);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("ERR_MULTIPLE_AT");
    });

    it("trims whitespace around input", () => {
      const r = parseEmail("  user@domain.com  ", defaults);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.localPart).toBe("user");
        expect(r.value.domain).toBe("domain.com");
      }
    });
  });
});
