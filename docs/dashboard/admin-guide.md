# Dashboard Admin Guide

Configuration, security, and deployment guide for the Claude Orchestrator Dashboard.

## Configuration

The dashboard is configured via `DashboardServerOptions` when creating the server instance.

### Server Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | `3210` | Port to listen on. Use `0` for a random available port. |
| `host` | `string` | `127.0.0.1` | Host to bind to. Use `0.0.0.0` to accept connections from any interface. |
| `state_dir` | `string` | (required) | Path to the orchestrator state directory containing `state.json`. |
| `logger` | `ILogger` | `undefined` | Logger instance for dashboard events. |
| `auth` | `AuthConfig` | `{ enabled: false }` | Authentication configuration. |
| `rateLimit` | `object` | `{ maxRequests: 100, windowMs: 60000 }` | Rate limiting configuration. |
| `static_dir` | `string` | `../public` | Path to static files directory for the web UI. |

### Example Configuration

```typescript
import { DashboardServer } from "@co/dashboard";

const server = new DashboardServer({
  port: 3210,
  host: "127.0.0.1",
  state_dir: "/var/lib/orchestrator/state",
  auth: {
    enabled: true,
    tokens: ["my-secret-token-123"],
  },
  rateLimit: {
    maxRequests: 200,
    windowMs: 60000,
  },
  logger: logger.child("dashboard"),
});

await server.start();
```

## Authentication

When enabled, the dashboard requires a Bearer token for the `/api/send` endpoint (write operations). Read-only endpoints (`/api/state`, `/api/workers`, etc.) do not require authentication.

### Enabling Authentication

```typescript
auth: {
  enabled: true,
  tokens: ["token-1", "token-2"],
}
```

### How It Works

1. Client sends `Authorization: Bearer <token>` header.
2. Server validates the token against the configured list.
3. Invalid or missing tokens return `401 Unauthorized`.

### Token Management

- Tokens are stored in plain text in the configuration. For production use, store tokens in environment variables or a secrets manager.
- Multiple tokens are supported for different clients or rotation.
- To rotate tokens: update the configuration and restart the server.

## Rate Limiting

The dashboard uses a token bucket algorithm per client IP address.

### Default Limits

- **100 requests per minute** per IP address.
- Rate limit headers are included in all responses:
  - `X-RateLimit-Limit` — Maximum requests per window.
  - `X-RateLimit-Remaining` — Remaining requests in current window.
  - `X-RateLimit-Reset` — Seconds until the window resets.

### Customizing Limits

```typescript
rateLimit: {
  maxRequests: 500,   // 500 requests per window
  windowMs: 300000,   // 5-minute window
}
```

### Handling Rate Limit Errors

When the limit is exceeded, the server returns:

```json
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 45

{"error": "Rate limit exceeded"}
```

## Network Configuration

### Local Development (Default)

Binds to `127.0.0.1:3210`. Only accessible from the local machine.

### LAN Access

```typescript
host: "0.0.0.0",  // Accept connections from any interface
```

### Reverse Proxy (Nginx)

```nginx
server {
    listen 80;
    server_name dashboard.example.com;

    location / {
        proxy_pass http://127.0.0.1:3210;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## State Directory

The dashboard reads orchestrator state from a `state.json` file in the configured `state_dir`. This file is written by the orchestrator's `StateWriter` component.

### Required Files

- `state.json` — Current orchestrator state (workers, tasks, events, chains).
- `commands.jsonl` — Command log (written by `/api/send`).

### Permissions

The dashboard process needs read access to `state.json` and write access to `commands.jsonl`. Ensure the running user has appropriate filesystem permissions.

## Troubleshooting

See [troubleshooting.md](./troubleshooting.md) for common issues.
