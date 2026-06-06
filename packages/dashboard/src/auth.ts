// Authentication and authorization for dashboard API
// Simple token-based auth for local development use

import type { IncomingMessage, ServerResponse } from "node:http";

export interface AuthConfig {
  /** Enable authentication (default: false) */
  enabled: boolean;
  /** API tokens that are allowed access */
  tokens: string[];
}

export interface AuthResult {
  authenticated: boolean;
  error?: string;
}

/**
 * Create authentication middleware for the dashboard API.
 * Returns a function that checks for valid Bearer token in Authorization header.
 */
export function createAuthMiddleware(config: AuthConfig) {
  return (req: IncomingMessage): AuthResult => {
    if (!config.enabled) {
      return { authenticated: true };
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return { authenticated: false, error: "Missing Authorization header" };
    }

    if (!authHeader.startsWith("Bearer ")) {
      return { authenticated: false, error: "Invalid Authorization format, expected Bearer token" };
    }

    const token = authHeader.slice(7);
    if (!token) {
      return { authenticated: false, error: "Empty token" };
    }

    if (config.tokens.length === 0) {
      return { authenticated: false, error: "No tokens configured" };
    }

    if (!config.tokens.includes(token)) {
      return { authenticated: false, error: "Invalid token" };
    }

    return { authenticated: true };
  };
}

/**
 * Send a 401 Unauthorized response.
 */
export function sendUnauthorized(res: ServerResponse, message?: string): void {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": 'Bearer realm="dashboard"',
  });
  res.end(JSON.stringify({ error: message || "Unauthorized" }));
}
