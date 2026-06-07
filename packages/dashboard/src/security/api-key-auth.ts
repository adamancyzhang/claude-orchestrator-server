// API key authentication for dashboard endpoints
// Supports header-based and query-parameter-based API key transmission

import type { IncomingMessage, ServerResponse } from "node:http";

export interface ApiKeyConfig {
  /** API keys that are granted access */
  keys: string[];
  /** Header name to look for the API key (default: "X-API-Key") */
  headerName?: string;
  /** Query parameter name to look for the API key (default: "api_key") */
  queryParam?: string;
  /** Whether to allow query parameter authentication (default: false for security) */
  allowQueryParam?: boolean;
}

export interface ApiKeyResult {
  authenticated: boolean;
  keyId?: string;
  error?: string;
}

/**
 * Validate an API key against the configured keys.
 * Uses constant-time comparison to prevent timing attacks.
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Create API key authentication middleware.
 * Checks for API key in the configured header or query parameter.
 */
export function createApiKeyAuth(config: ApiKeyConfig) {
  const headerName = config.headerName ?? "X-API-Key";
  const queryParam = config.queryParam ?? "api_key";
  const allowQueryParam = config.allowQueryParam ?? false;

  return (req: IncomingMessage): ApiKeyResult => {
    if (config.keys.length === 0) {
      return { authenticated: false, error: "No API keys configured" };
    }

    // Check header first
    const headerKey = req.headers[headerName.toLowerCase()];
    if (typeof headerKey === "string" && headerKey) {
      const matchedIndex = config.keys.findIndex((k) => constantTimeCompare(k, headerKey));
      if (matchedIndex >= 0) {
        return { authenticated: true, keyId: `key-${matchedIndex}` };
      }
      return { authenticated: false, error: "Invalid API key" };
    }

    // Check query parameter if allowed
    if (allowQueryParam && req.url) {
      try {
        const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
        const queryKey = url.searchParams.get(queryParam);
        if (queryKey) {
          const matchedIndex = config.keys.findIndex((k) => constantTimeCompare(k, queryKey));
          if (matchedIndex >= 0) {
            return { authenticated: true, keyId: `key-${matchedIndex}` };
          }
          return { authenticated: false, error: "Invalid API key" };
        }
      } catch {
        // Malformed URL, ignore query param
      }
    }

    return { authenticated: false, error: "Missing API key" };
  };
}

/**
 * Send a 401 Unauthorized response for API key failures.
 */
export function sendApiKeyUnauthorized(res: ServerResponse, message?: string): void {
  res.writeHead(401, {
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ error: message || "Unauthorized" }));
}
