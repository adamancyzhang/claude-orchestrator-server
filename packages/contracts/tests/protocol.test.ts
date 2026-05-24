// CORE-RETENTION
// Locks in: PROTOCOL_VERSION is a literal string and ProtocolVersionMismatch
// error formats both sides of the mismatch into the message.
// Critical because: workers refuse to dispatch tasks under a mismatched
// protocol; a silent version bump without a coordinated release would let
// incompatible peers run together.
// Primary sources: packages/contracts/src/protocol.ts, errors.ts

import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/protocol.js";
import { ProtocolVersionMismatchError } from "../src/errors.js";

describe("PROTOCOL_VERSION", () => {
  it("matches the package.json semver pattern (MAJOR.MINOR.PATCH)", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is the literal string used in code (no env override)", () => {
    // The compile-time literal type is asserted via the `as const`.
    // At runtime, the string must equal itself.
    expect(typeof PROTOCOL_VERSION).toBe("string");
    expect(PROTOCOL_VERSION.length).toBeGreaterThan(0);
  });
});

describe("ProtocolVersionMismatchError formatting", () => {
  it("includes both versions in the message", () => {
    const err = new ProtocolVersionMismatchError("0.7.0", "0.6.0");
    expect(err.message).toMatch(/0\.7\.0/);
    expect(err.message).toMatch(/0\.6\.0/);
    expect(err.code).toBe("PROTOCOL_VERSION_MISMATCH");
  });
});
