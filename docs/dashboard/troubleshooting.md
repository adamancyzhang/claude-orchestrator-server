# Dashboard Troubleshooting

Common issues and solutions for the Claude Orchestrator Dashboard.

## Connection Issues

### Dashboard shows "No data" or empty state

**Cause:** The orchestrator is not running, or the `state_dir` path is incorrect.

**Solution:**
1. Verify the orchestrator is running and writing to `state.json`.
2. Check that `state_dir` points to the correct directory.
3. Confirm the file exists: `ls <state_dir>/state.json`.

### WebSocket connection fails

**Cause:** Network proxy or firewall blocking WebSocket upgrade.

**Solution:**
1. Check browser console for WebSocket errors.
2. If behind a reverse proxy, ensure it supports WebSocket upgrade (see [admin-guide.md](./admin-guide.md#reverse-proxy-nginx)).
3. Try connecting directly to `http://127.0.0.1:3210` to rule out proxy issues.

### Real-time updates stop working

**Cause:** WebSocket connection dropped and did not reconnect.

**Solution:**
1. Refresh the page to re-establish the connection.
2. Check the server logs for connection errors.
3. If behind a proxy, check proxy timeout settings (WebSocket connections are long-lived).

## Authentication Issues

### 401 Unauthorized on /api/send

**Cause:** Authentication is enabled but the request is missing or has an invalid token.

**Solution:**
1. Include the `Authorization: Bearer <token>` header.
2. Verify the token matches one configured in `auth.tokens`.
3. Check for typos or extra whitespace in the token.

### Authentication enabled but /api/state returns 401

**Cause:** This should not happen — read endpoints do not require authentication.

**Solution:**
1. Check if a proxy is adding authentication headers incorrectly.
2. Verify the auth middleware is only applied to `/api/send`.

## Rate Limiting Issues

### 429 Too Many Requests

**Cause:** The client has exceeded the rate limit (default: 100 requests/minute).

**Solution:**
1. Check the `X-RateLimit-Reset` header to see when the limit resets.
2. Reduce request frequency.
3. Increase the limit in configuration if needed:
   ```typescript
   rateLimit: { maxRequests: 200, windowMs: 60000 }
   ```

### Rate limit applied to health checks

**Cause:** The health check endpoint is subject to the same rate limit.

**Solution:** If monitoring tools poll `/api/health` frequently, increase the rate limit or exclude health checks in a reverse proxy.

## Performance Issues

### Dashboard is slow to load

**Cause:** Large state file or too many connected clients.

**Solution:**
1. Check the size of `state.json` — large files slow initial load.
2. Reduce event history retention if events are accumulating.
3. Check server resource usage (CPU, memory).

### High CPU usage on dashboard server

**Cause:** Many concurrent WebSocket/SSE connections or frequent state updates.

**Solution:**
1. Limit the number of concurrent dashboard clients.
2. Increase the StateWriter's write interval to reduce update frequency.
3. Check for client-side rendering issues (infinite loops in UI updates).

## Data Issues

### State shows stale data

**Cause:** The StateWatcher is not detecting file changes.

**Solution:**
1. Verify `state.json` is being updated by the orchestrator.
2. Check filesystem permissions — the dashboard process needs read access.
3. On some filesystems (NFS, WSL), `fs.watch` may not work reliably. Restart the dashboard.

### /api/send returns "Invalid command"

**Cause:** The request body is not valid JSON or is missing required fields.

**Solution:**
1. Ensure `Content-Type: application/json` header is set.
2. Validate the JSON body is well-formed.
3. Check server logs for the specific parse error.

### Commands not appearing in commands.jsonl

**Cause:** The state directory is read-only or does not exist.

**Solution:**
1. Verify the dashboard process has write access to `state_dir`.
2. Ensure the directory exists (it is created automatically, but check permissions).

## Logging

The dashboard logs to the provided `ILogger` instance. Key log messages:

| Level | Message | Meaning |
|-------|---------|---------|
| `info` | `dashboard server started` | Server is listening |
| `info` | `dashboard server stopped` | Server shut down cleanly |
| `error` | `failed to read state` | Cannot read state.json |
| `error` | `failed to send command` | Command processing error |

To enable debug logging, pass a logger with level set to `debug`.

## Getting Help

1. Check the server logs for error messages.
2. Review the API documentation at `/api/docs`.
3. Verify the orchestrator is running and healthy.
