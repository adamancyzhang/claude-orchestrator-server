# Scalability Guide

## Architecture Overview

The orchestrator server is designed with a distributed architecture to support horizontal and vertical scaling. Key components include:

- **Leader Node**: Manages task assignment and coordination
- **Worker Nodes**: Execute tasks in parallel
- **Dashboard Server**: Provides monitoring and management interface
- **Infrastructure Services**: Metrics collection, alerting, and historical data storage

### Horizontal Scaling

Add more worker nodes to increase task throughput. The leader node automatically distributes tasks across available workers using load balancing algorithms.

### Vertical Scaling

Increase CPU/memory resources on existing nodes to handle more complex tasks or higher concurrency per worker.

## Configuration Guide by Scale

### Small Scale (1-5 workers)

```yaml
# config.yaml
leader:
  port: 3000
  max_workers: 5
  task_timeout: 300000  # 5 minutes

workers:
  concurrency: 2
  memory_limit: "512MB"

dashboard:
  enabled: true
  port: 3210
```

### Medium Scale (6-20 workers)

```yaml
# config.yaml
leader:
  port: 3000
  max_workers: 20
  task_timeout: 600000  # 10 minutes
  load_balancing: "round-robin"

workers:
  concurrency: 4
  memory_limit: "1GB"

dashboard:
  enabled: true
  port: 3210
  rate_limit:
    max_requests: 100
    window_ms: 60000

metrics:
  collection_interval: 10000  # 10 seconds
  retention_days: 30
```

### Large Scale (21-100 workers)

```yaml
# config.yaml
leader:
  port: 3000
  max_workers: 100
  task_timeout: 900000  # 15 minutes
  load_balancing: "least-connections"

workers:
  concurrency: 8
  memory_limit: "2GB"

dashboard:
  enabled: true
  port: 3210
  rate_limit:
    max_requests: 500
    window_ms: 60000
  auth:
    enabled: true
    secret: "${JWT_SECRET}"

metrics:
  collection_interval: 5000  # 5 seconds
  retention_days: 90
  compression:
    enabled: true
    threshold_days: 7

alerting:
  enabled: true
  rules:
    - name: high_cpu
      metric: cpu_usage
      threshold: 80
      duration: 300
      channels: ["webhook", "log"]
```

### Enterprise Scale (100+ workers)

```yaml
# config.yaml
leader:
  port: 3000
  max_workers: 500
  task_timeout: 1800000  # 30 minutes
  load_balancing: "weighted"
  health_check_interval: 5000

workers:
  concurrency: 16
  memory_limit: "4GB"
  auto_scale: true
  min_instances: 10
  max_instances: 100

dashboard:
  enabled: true
  port: 3210
  rate_limit:
    max_requests: 1000
    window_ms: 60000
  auth:
    enabled: true
    secret: "${JWT_SECRET}"
    token_expiry: 3600

metrics:
  collection_interval: 2000  # 2 seconds
  retention_days: 365
  compression:
    enabled: true
    threshold_days: 7
  storage:
    type: "timescaledb"
    connection_string: "${METRICS_DB_URL}"

alerting:
  enabled: true
  rules:
    - name: high_cpu
      metric: cpu_usage
      threshold: 80
      duration: 300
      channels: ["webhook", "email"]
    - name: high_memory
      metric: memory_usage
      threshold: 85
      duration: 300
      channels: ["webhook"]
    - name: task_failure_rate
      metric: task_failure_rate
      threshold: 5
      duration: 600
      channels: ["webhook", "slack"]

historical_data:
  enabled: true
  storage_dir: "./data/history"
  retention_days: 365
  compression:
    enabled: true
    threshold_days: 7
```

## Performance Tuning

### Leader Node

- **Task Distribution**: Use `least-connections` or `weighted` load balancing for better distribution
- **Health Checks**: Enable frequent health checks (5-10 seconds) to detect failed workers quickly
- **Timeout Configuration**: Set appropriate timeouts based on task complexity

### Worker Nodes

- **Concurrency**: Increase concurrency based on CPU cores (2-4x cores recommended)
- **Memory Limits**: Set memory limits to prevent OOM kills
- **Garbage Collection**: Tune Node.js GC settings for large memory heaps

### Dashboard Server

- **Rate Limiting**: Configure rate limits based on expected user load
- **Caching**: Enable caching for static assets and API responses
- **WebSocket**: Use WebSocket for real-time updates instead of polling

### Metrics Collection

- **Collection Interval**: Balance between granularity and overhead (2-10 seconds)
- **Compression**: Enable compression for historical data to reduce storage
- **Retention**: Set retention policies based on compliance requirements

## Capacity Planning

### Resource Estimation

| Scale | Workers | CPU (cores) | Memory (GB) | Storage (GB) |
|-------|---------|-------------|-------------|--------------|
| Small | 1-5 | 2-4 | 2-4 | 10-50 |
| Medium | 6-20 | 4-8 | 4-16 | 50-200 |
| Large | 21-100 | 8-32 | 16-64 | 200-1000 |
| Enterprise | 100+ | 32+ | 64+ | 1000+ |

### Task Throughput

- **Small**: 10-50 tasks/minute
- **Medium**: 50-200 tasks/minute
- **Large**: 200-1000 tasks/minute
- **Enterprise**: 1000+ tasks/minute

### Monitoring Metrics

Track these metrics to identify bottlenecks:

1. **Task Queue Length**: Number of pending tasks
2. **Worker Utilization**: CPU and memory usage per worker
3. **Task Duration**: Average and 95th percentile task completion time
4. **Error Rate**: Percentage of failed tasks
5. **Leader Response Time**: API response time for task assignment

### Scaling Triggers

Scale up when:
- Worker utilization consistently > 80%
- Task queue length > 2x worker count
- Task duration increasing over time
- Error rate > 1%

Scale down when:
- Worker utilization < 30% for extended period
- Task queue consistently empty
- Resource costs exceed requirements
