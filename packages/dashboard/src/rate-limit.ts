// Rate limiting for dashboard API endpoints
// Token bucket algorithm for fair rate limiting

export interface RateLimitConfig {
  /** Maximum requests per window (default: 100) */
  maxRequests: number;
  /** Window duration in milliseconds (default: 60000 = 1 minute) */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

interface Bucket {
  count: number;
  resetTime: number;
}

/**
 * Token bucket rate limiter.
 * Tracks request counts per IP address.
 */
export class RateLimiter {
  private buckets: Map<string, Bucket> = new Map();
  private config: RateLimitConfig;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      maxRequests: config.maxRequests ?? 100,
      windowMs: config.windowMs ?? 60000,
    };

    // Cleanup stale buckets every minute
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        if (now > bucket.resetTime) {
          this.buckets.delete(key);
        }
      }
    }, 60000);
  }

  /**
   * Check rate limit for a given key (typically IP address).
   */
  check(key: string): RateLimitResult {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    // Create new bucket or reset if window expired
    if (!bucket || now > bucket.resetTime) {
      bucket = {
        count: 0,
        resetTime: now + this.config.windowMs,
      };
      this.buckets.set(key, bucket);
    }

    bucket.count++;

    const remaining = Math.max(0, this.config.maxRequests - bucket.count);
    const resetMs = bucket.resetTime - now;

    return {
      allowed: bucket.count <= this.config.maxRequests,
      remaining,
      resetMs,
    };
  }

  /**
   * Stop cleanup interval.
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
