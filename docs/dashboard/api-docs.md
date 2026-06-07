# Dashboard API Reference

REST API for monitoring and controlling the Claude Orchestrator.

**Base URL:** `http://127.0.0.1:3210`

## Endpoints

### GET /api/state

Returns the current orchestrator state.

**Response:**
```json
{
  "workers": [...],
  "tasks": [...],
  "events": [...],
  "chains": [...]
}
```

**Status Codes:**
- `200` — Success
- `404` — State file not found (orchestrator not running)

---

### GET /api/workers

Returns worker status and health information.

**Response:**
```json
{
  "workers": [
    {
      "id": "worker-1",
      "name": "Worker1",
      "role": "executor",
      "status": "idle",
      "last_heartbeat": "2026-06-07T10:00:00Z"
    }
  ]
}
```

**Status Codes:**
- `200` — Success
- `404` — State file not found

---

### GET /api/tasks

Returns the task list with status.

**Response:**
```json
[
  {
    "id": "task-1",
    "status": "pending",
    "description": "Review code",
    "assigned_to": "worker-1"
  }
]
```

**Status Codes:**
- `200` — Success

---

### GET /api/events

Returns event history.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | `number` | `50` | Maximum number of events to return |

**Response:**
```json
[
  {
    "type": "worker_joined",
    "timestamp": "2026-06-07T10:00:00Z",
    "data": { ... }
  }
]
```

**Status Codes:**
- `200` — Success

---

### GET /api/chains

Returns audit chain data.

**Response:**
```json
[
  {
    "id": "chain-1",
    "status": "active",
    "tasks": [...],
    "created_at": "2026-06-07T10:00:00Z"
  }
]
```

**Status Codes:**
- `200` — Success

---

### POST /api/send

Send a command to the orchestrator. **Requires authentication when enabled.**

**Request Body:**
```json
{
  "command": "dispatch",
  "args": {
    "task": "review code",
    "target": "dev-1"
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Command sent"
}
```

**Status Codes:**
- `200` — Command accepted
- `400` — Invalid JSON or command
- `401` — Authentication required or invalid token

---

### GET /api/events/stream

Server-Sent Events endpoint for real-time state updates.

**Response:** `text/event-stream`

**Event Types:**
- `state` — Full state update on any change

**Example:**
```bash
curl -N http://127.0.0.1:3210/api/events/stream
```

**Status Codes:**
- `200` — Stream opened

---

### GET /api/docs

Returns API documentation.

**Response:**
- With `Accept: text/html` — Returns an HTML documentation page.
- Otherwise — Returns JSON array of endpoint definitions.

---

### GET /api/health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "version": "1.0.0"
}
```

**Status Codes:**
- `200` — Healthy

## WebSocket

The dashboard also provides a WebSocket endpoint at the server root for real-time updates. The WebSocket server automatically broadcasts state changes to all connected clients.

**Event Format:**
```json
{
  "type": "state",
  "data": { ... }
}
```

## Authentication

When authentication is enabled, the following applies:

- **Read endpoints** (`GET /api/state`, `/api/workers`, etc.) — No authentication required.
- **Write endpoints** (`POST /api/send`) — Bearer token required.

**Header:**
```
Authorization: Bearer <token>
```

**Error Response (401):**
```json
{
  "error": "Missing Authorization header"
}
```

## Rate Limiting

All endpoints are subject to rate limiting (default: 100 requests/minute per IP).

**Headers:**
- `X-RateLimit-Limit` — Maximum requests per window
- `X-RateLimit-Remaining` — Remaining requests
- `X-RateLimit-Reset` — Seconds until window resets

**Error Response (429):**
```json
{
  "error": "Rate limit exceeded"
}
```

## CORS

The dashboard includes permissive CORS headers for local development:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type, Authorization`
