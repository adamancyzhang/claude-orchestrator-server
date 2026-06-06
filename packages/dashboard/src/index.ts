export { DashboardServer, type DashboardServerOptions } from "./server.js";
export { SSEBroadcaster, type SSEClient } from "./sse/broadcaster.js";
export { StateWatcher, type StateUpdateCallback } from "./watcher.js";
export { createAuthMiddleware, sendUnauthorized, type AuthConfig, type AuthResult } from "./auth.js";
export { RateLimiter, type RateLimitConfig, type RateLimitResult } from "./rate-limit.js";
export { getApiDocs, generateDocsHtml, type ApiEndpoint } from "./docs.js";
