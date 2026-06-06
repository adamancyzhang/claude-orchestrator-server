# Dashboard Architecture

## Overview

The dashboard provides a real-time web interface for monitoring and controlling orchestrator sessions. It runs as a local server, binding to localhost only, and communicates with the orchestrator through the filesystem (state.json and commands.jsonl).

## Architecture Diagram

```
┌─────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│   Browser   │────▶│  Dashboard Server   │────▶│   Orchestrator   │
│  (React)    │◀────│  @co/dashboard      │◀────│   (writes state) │
└─────────────┘     └─────────────────────┘     └──────────────────┘
       │                      │                          │
       │                      │                          │
       │    SSE Broadcast     │      File Watching       │
       │◀─────────────────────│◀─────────────────────────│
       │                      │                          │
       │    REST API          │      commands.jsonl      │
       │─────────────────────▶│─────────────────────────▶│
       │                      │                          │
```

**Data flow components:**

- **SSE Broadcast:** Real-time event streaming from server to browser clients
- **File Watching:** Dashboard watches state.json for changes from Orchestrator
- **REST API:** On-demand queries for state, workers, tasks, events, chains
- **Commands:** POST /api/send writes to commands.jsonl for Orchestrator pickup

## Technology Stack

### Frontend

| Technology | Purpose |
|------------|---------|
| React 18+ | UI framework with concurrent features |
| TypeScript | Type safety across the stack |
| Vite | Build tooling and dev server |
| Tailwind CSS | Utility-first styling |
| Recharts / Visx | Data visualization for metrics |

### Backend

| Technology | Purpose |
|------------|---------|
| @co/dashboard | Custom package for dashboard server |
| Node.js native HTTP | Zero-dependency HTTP server |
| SSE (Server-Sent Events) | Real-time event streaming |
| fs.watch | File system monitoring for state changes |

## Data Flow

### Real-time Updates

```
Orchestrator writes state.json
        │
        ▼
Dashboard Server watches file
        │
        ▼
Parse state.json changes
        │
        ▼
SSE broadcast to connected clients
```

**Update frequency:** 2 events per second (debounced)

### On-demand Queries

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/state` | GET | Current orchestrator state |
| `/api/workers` | GET | Worker status and health |
| `/api/tasks` | GET | Task list with status |
| `/api/events` | GET | Event history |
| `/api/chains` | GET | Audit chain data |

### Command Interface

```
POST /api/send
Body: { "command": "...", "args": {...} }
        │
        ▼
Append to commands.jsonl
        │
        ▼
Orchestrator picks up command
```

## Security

- **Localhost-only binding:** Server binds to `127.0.0.1` by default
- **No authentication:** Local tool does not require auth for development workflow
- **No external access:** Cannot be accessed from network by design

## Scalability

| Metric | Target |
|--------|--------|
| Sessions | Single session per dashboard instance |
| Memory | <50MB for dashboard server |
| Update frequency | 2 events per second |
| Concurrent clients | Multiple browser tabs supported via SSE |

## Package Structure

```
packages/dashboard/
├── src/
│   ├── server.ts              # Main HTTP server
│   ├── routes/
│   │   ├── state.ts           # GET /api/state
│   │   ├── workers.ts         # GET /api/workers
│   │   ├── tasks.ts           # GET /api/tasks
│   │   ├── events.ts          # GET /api/events
│   │   ├── chains.ts          # GET /api/chains
│   │   └── send.ts            # POST /api/send
│   ├── sse/
│   │   ├── broadcaster.ts     # SSE connection management
│   │   └── handler.ts         # SSE endpoint handler
│   ├── watcher.ts             # File system watcher for state.json
│   └── index.ts               # Package exports
├── public/                    # Static frontend assets
├── tests/
│   ├── server.test.ts
│   ├── routes/
│   └── sse/
└── package.json
```

## CLI Integration

```bash
# Start dashboard with default settings
claude-orchestrator dashboard

# Custom port and host
claude-orchestrator dashboard --port 3210 --host 127.0.0.1

# With existing orchestrator session
claude-orchestrator dashboard --state-dir ./state
```

**CLI flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | 3210 | Server port |
| `--host` | 127.0.0.1 | Bind address |
| `--state-dir` | .orchestrator | Path to orchestrator state directory |

## Historical Data Retention

The dashboard maintains a 30-day rolling history of state snapshots for trend analysis and debugging.

### Storage Format

- **Format:** JSONL (append-only log)
- **Location:** `<state-dir>/history/YYYY-MM-DD.jsonl`
- **Content:** Lightweight state summaries (not full state.json)
- **Record format:** `{ "ts": "ISO-8601", "workers": N, "tasks": { "total": N, "completed": N, "failed": N }, "metrics": {...} }`

### Collection

| Component | Behavior |
|-----------|----------|
| HistoryRecorder | Reads state.json every 60 seconds |
| Write mode | Append single JSONL line per snapshot |
| Retention | Auto-delete files older than 30 days |
| Config | `--history-retention-days` flag (default: 30) |

### Storage Estimates

| Period | Snapshots | Size |
|--------|-----------|------|
| 1 day | 1,440 | ~0.3MB |
| 7 days | 10,080 | ~2.1MB |
| 30 days | 43,200 | ~8.6MB |

### History API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/history` | GET | Recent history (query: `?days=7`) |
| `/api/history/range` | GET | Date range query (query: `?from=...&to=...`) |
| `/api/history/today` | GET | Today's snapshots |

## Alerting Notifications

The dashboard includes a real-time alerting system that surfaces metric threshold violations.

### AlertBus Architecture

```
MetricsCollector (threshold check)
        │
        ▼
    AlertBus (EventEmitter)
        │
        ▼
SSE broadcast (event: alert)
        │
        ▼
Dashboard UI (banner + history panel)
```

### SSE Alert Events

```
event: alert
data: {"id":"alert-123","severity":"critical","message":"Error rate exceeded","ts":"..."}
```

### Alert API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/alerts` | GET | Current active alerts |
| `/api/alerts/history` | GET | Resolved alert history |
| `/api/alerts/:id/resolve` | POST | Mark alert as resolved |

### Alert Persistence

- **Storage:** `<state-dir>/alerts.jsonl`
- **Format:** Append-only log of all alert events (created, resolved)
- **Retention:** Follows same 30-day retention as history

### Dashboard UI

- **Persistent banner:** Top-of-page alert for active critical/warning alerts
- **Alert history panel:** Sidebar showing resolved and active alerts
- **Manual resolve:** Button to acknowledge and dismiss alerts

## Implementation Notes

1. **State polling:** Use fs.watch with debouncing to avoid excessive updates
2. **SSE reconnection:** Client automatically reconnects on connection loss
3. **Graceful shutdown:** Close SSE connections and stop watcher on SIGTERM
4. **Error handling:** Return proper HTTP status codes for all endpoints
5. **CORS:** Not needed since frontend is served from same origin
6. **History rotation:** Use daily file names for easy cleanup and range queries
7. **Alert deduplication:** Suppress repeated alerts within 60-second window
