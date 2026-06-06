// CORE-RETENTION
// Locks in: RateLimiter — token bucket algorithm, window expiration.
// Critical because: Rate limiting prevents API abuse.
// A broken rate limiter either blocks all requests or allows unlimited access.
// Primary sources: packages/dashboard/src/rate-limit.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "../src/rate-limit.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });
  });

  afterEach(() => {
    limiter.destroy();
    vi.useRealTimers();
  });

  it("creates instance with default config", () => {
    const defaultLimiter = new RateLimiter();
    expect(defaultLimiter).toBeDefined();
    defaultLimiter.destroy();
  });

  it("allows requests within limit", () => {
    const result = limiter.check("ip1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("tracks remaining requests", () => {
    limiter.check("ip1");
    limiter.check("ip1");
    const result = limiter.check("ip1");
    expect(result.remaining).toBe(2);
  });

  it("blocks requests over limit", () => {
    for (let i = 0; i < 5; i++) {
      limiter.check("ip1");
    }
    const result = limiter.check("ip1");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("resets after window expires", () => {
    for (let i = 0; i < 5; i++) {
      limiter.check("ip1");
    }
    expect(limiter.check("ip1").allowed).toBe(false);

    // Advance time past window
    vi.advanceTimersByTime(1001);

    const result = limiter.check("ip1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("tracks different keys separately", () => {
    limiter.check("ip1");
    limiter.check("ip1");
    limiter.check("ip2");

    expect(limiter.check("ip1").remaining).toBe(2);
    expect(limiter.check("ip2").remaining).toBe(3);
  });

  it("provides reset time", () => {
    const result = limiter.check("ip1");
    expect(result.resetMs).toBeGreaterThan(0);
    expect(result.resetMs).toBeLessThanOrEqual(1000);
  });

  it("cleans up stale buckets", () => {
    limiter.check("ip1");
    limiter.check("ip2");

    // Advance time past window + cleanup interval
    vi.advanceTimersByTime(61000);

    // Buckets should be cleaned up, allowing fresh requests
    const result1 = limiter.check("ip1");
    const result2 = limiter.check("ip2");
    expect(result1.remaining).toBe(4);
    expect(result2.remaining).toBe(4);
  });

  it("destroy() stops cleanup interval", () => {
    const testLimiter = new RateLimiter();
    testLimiter.destroy();
    // Should not throw
  });
});
