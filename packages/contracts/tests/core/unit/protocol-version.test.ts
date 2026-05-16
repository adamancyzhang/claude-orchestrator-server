// CORE-RETENTION
// Locks in: PROTOCOL_VERSION constant — incrementing it is a wire-format
//   break; Leader and Worker handshake on this value at startup.
// Core path because: forgetting to bump this on a wire-format change would
//   silently mix incompatible payloads from old/new instances.
// Owner subsystem: contracts.
// Primary source files exercised:
//   - packages/contracts/src/protocol.ts

import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../../src/index.js";

describe("PROTOCOL_VERSION", () => {
  it("is exactly '0.6.0' (handshake constant)", () => {
    expect(PROTOCOL_VERSION).toBe("0.6.0");
  });
});
