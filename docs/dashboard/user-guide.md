# Dashboard User Guide

The Claude Orchestrator Dashboard provides a real-time web interface for monitoring and controlling the orchestrator system.

## Getting Started

### Opening the Dashboard

Once the orchestrator is running, open your browser and navigate to:

```
http://127.0.0.1:3210
```

The dashboard loads automatically and begins receiving real-time updates via WebSocket.

### Main Views

The dashboard displays the following information:

- **Workers** — List of registered worker instances with their status (idle/busy), role, and last heartbeat time.
- **Tasks** — Current task queue showing task status, assigned worker, and progress.
- **Events** — Real-time event feed from the orchestrator.
- **Chains** — Audit chain data showing task groupings and outcomes.
- **Metrics** — Performance charts with throughput, latency, and resource usage over time.

## Real-Time Updates

The dashboard supports two mechanisms for real-time updates:

### WebSocket (Recommended)

The primary transport. Connects automatically on page load and receives state updates as they happen. The connection reconnects automatically if dropped.

### Server-Sent Events (SSE)

Available at `/api/events/stream` for clients that prefer SSE over WebSocket. Useful for integrations and scripting.

```
curl -N http://127.0.0.1:3210/api/events/stream
```

## Sending Commands

You can send commands to the orchestrator through the dashboard UI or via the API:

```
POST /api/send
Content-Type: application/json

{
  "command": "dispatch",
  "args": {
    "task": "review code",
    "target": "dev-1"
  }
}
```

If authentication is enabled, include a Bearer token:

```
Authorization: Bearer <your-token>
```

## Keyboard Shortcuts

- `R` — Refresh state
- `ESC` — Close modals/panels

## Browser Compatibility

The dashboard works in modern browsers (Chrome, Firefox, Safari, Edge). WebSocket support is required for real-time updates.
