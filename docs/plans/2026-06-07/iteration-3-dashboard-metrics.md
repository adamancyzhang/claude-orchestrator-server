# Iteration 3 - Dashboard Metrics & Test Fixes — 2026-06-07

## Overview
Fix failing tests, then complete the remaining dashboard metrics features (collection, visualization, alerting, historical data).

## Current State
- 855 tests passing across all packages
- 2 failing tests in `packages/leader` (load-balancer, stream-tailer)
- V3.0 P0 Performance tasks 1.1–1.6 complete
- V3.0 P0 Dashboard tasks 2.1, 2.2, 2.4 complete

---

## Task 1: Fix failing tests (leader package)
- **Files:** `packages/leader/tests/load-balancer.test.ts`, `packages/leader/tests/stream-tailer.test.ts`
- **Why:** 2 tests failing — load-balancer selects wrong worker, stream-tailer doesn't detect file shrink
- **Scope:** Fix the bugs or fix the tests (investigate root cause first)
- **Assignee:** dev-1

## Task 2: Metrics Collection Service
- **File:** `packages/infra/src/metrics-collection-service.ts` (new)
- **Why:** Needed for real-time visualization, alerting, and historical data
- **Scope:**
  - Collect metrics from all orchestrator components
  - Aggregate by time intervals (1min, 5min, 1hour)
  - In-memory time-series store with 30-day retention
  - Export interface for Prometheus
- **Acceptance Criteria:** Service collects, aggregates, and stores metrics; unit tests pass
- **Assignee:** dev-2

## Task 3: Real-time Metrics Visualization
- **File:** `packages/dashboard/src/realtime/` (new directory)
- **Why:** Core dashboard feature — live charts for agents, tasks, performance
- **Scope:**
  - WebSocket-based real-time data push
  - Chart components for key metrics (agents active, task throughput, latency)
  - Historical data query (last hour, day, week)
- **Acceptance Criteria:** Dashboard shows live updating charts; data matches collected metrics
- **Assignee:** dev-3

## Task 4: Alerting System
- **File:** `packages/infra/src/alerting/` (new directory)
- **Why:** Critical for production — notify on threshold breaches
- **Scope:**
  - Configurable alert rules (threshold, duration)
  - Notification channels: webhook, log
  - Alert state machine (ok → firing → resolved)
  - Alert history
- **Acceptance Criteria:** Alerts fire when thresholds exceeded; state transitions correct; tests pass
- **Assignee:** dev-1 (after Task 1)

## Task 5: Historical Data Management
- **File:** `packages/infra/src/historical-data.ts` (new)
- **Why:** Needed for trend analysis and dashboard historical views
- **Scope:**
  - Store aggregated metrics with timestamps
  - Data compression for older entries (1h → 1d granularity after 7 days)
  - Query by time range and metric name
  - Retention policy enforcement (30 days)
- **Acceptance Criteria:** Data stored, queried, compressed correctly; retention enforced; tests pass
- **Assignee:** dev-2 (after Task 2)

## Task 6: Dashboard Security
- **File:** `packages/dashboard/src/security/` (new directory)
- **Why:** Production requirement — auth and input validation
- **Scope:**
  - API key authentication for dashboard endpoints
  - Input validation and XSS protection
  - Audit logging for access
- **Acceptance Criteria:** Unauthorized requests rejected; inputs sanitized; audit log written
- **Assignee:** dev-3 (after Task 3)

---

## Verification Chain
Each task: dev → qa-engineer (scoped tests) → verifier (sign-off)

## Success Criteria
- All 2 failing tests fixed, 0 failures
- Metrics collection service with unit tests
- Real-time visualization functional
- Alerting system with state machine tests
- Historical data with retention tests
- Dashboard security with auth tests
- All changes committed with hash recorded
