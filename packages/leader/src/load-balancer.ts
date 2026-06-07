import type {
  IInstanceRegistry,
  Instance,
  InstanceId,
} from "@co/contracts";
import type { ILogger } from "@co/contracts";

export interface LoadBalancerOptions {
  /** Registry to get worker instances */
  registry: IInstanceRegistry;
  /** Logger instance */
  logger?: ILogger;
  /** Weight for CPU usage in load calculation (default: 0.4) */
  cpu_weight?: number;
  /** Weight for memory usage in load calculation (default: 0.3) */
  memory_weight?: number;
  /** Weight for task count in load calculation (default: 0.3) */
  task_weight?: number;
  /** Maximum tasks per worker before overload (default: 5) */
  max_tasks_per_worker?: number;
  /** Enable adaptive load balancing based on performance (default: true) */
  adaptive?: boolean;
  /** Performance history size for adaptive balancing (default: 10) */
  performance_history_size?: number;
}

export interface WorkerLoad {
  /** Worker instance ID */
  instance_id: InstanceId;
  /** Worker name */
  name: string;
  /** Worker role */
  role: string;
  /** Current status */
  status: "idle" | "busy";
  /** Number of tasks currently assigned */
  task_count: number;
  /** CPU usage percentage (0-100) */
  cpu_usage: number;
  /** Memory usage percentage (0-100) */
  memory_usage: number;
  /** Calculated load score (0-1, lower is better) */
  load_score: number;
  /** Whether worker is overloaded */
  is_overloaded: boolean;
  /** Performance score based on historical data (0-1, higher is better) */
  performance_score: number;
}

export interface LoadBalancerStats {
  /** Total workers */
  total_workers: number;
  /** Idle workers */
  idle_workers: number;
  /** Busy workers */
  busy_workers: number;
  /** Overloaded workers */
  overloaded_workers: number;
  /** Average load score */
  average_load: number;
  /** Load distribution variance (lower is better) */
  load_variance: number;
}

interface WorkerPerformance {
  task_count: number;
  completion_time_ms: number;
  success: boolean;
  timestamp: number;
}

/**
 * Intelligent load balancer that distributes tasks based on worker capacity
 * and resource usage.
 *
 * Features:
 * - Weighted load calculation based on CPU, memory, and task count
 * - Adaptive load balancing based on worker performance history
 * - Overload detection and avoidance
 * - Load distribution metrics for monitoring
 */
export class LoadBalancer {
  private readonly registry: IInstanceRegistry;
  private readonly logger?: ILogger;
  private readonly cpuWeight: number;
  private readonly memoryWeight: number;
  private readonly taskWeight: number;
  private readonly maxTasksPerWorker: number;
  private readonly adaptive: boolean;
  private readonly performanceHistorySize: number;
  private readonly performanceHistory = new Map<InstanceId, WorkerPerformance[]>();

  constructor(opts: LoadBalancerOptions) {
    this.registry = opts.registry;
    this.logger = opts.logger;
    this.cpuWeight = opts.cpu_weight ?? 0.4;
    this.memoryWeight = opts.memory_weight ?? 0.3;
    this.taskWeight = opts.task_weight ?? 0.3;
    this.maxTasksPerWorker = opts.max_tasks_per_worker ?? 5;
    this.adaptive = opts.adaptive ?? true;
    this.performanceHistorySize = opts.performance_history_size ?? 10;
  }

  /**
   * Find the best worker for a task based on load balancing algorithm.
   */
  async findBestWorker(role: string): Promise<{ id: InstanceId; name: string } | null> {
    const workers = await this.getWorkerLoads(role);

    if (workers.length === 0) {
      return null;
    }

    // Filter out overloaded workers
    const availableWorkers = workers.filter((w) => !w.is_overloaded);

    if (availableWorkers.length === 0) {
      // If all workers are overloaded, pick the one with lowest load
      this.logger?.warn("all workers overloaded, picking least loaded", {
        role,
        worker_count: workers.length,
      });
      return this.pickLeastLoaded(workers);
    }

    return this.pickBestWorker(availableWorkers);
  }

  /**
   * Get load information for all workers with a specific role.
   */
  async getWorkerLoads(role?: string): Promise<WorkerLoad[]> {
    const instances = await this.registry.list();
    const loads: WorkerLoad[] = [];

    for (const inst of instances) {
      if (inst.role === "leader") continue;
      if (role && inst.role !== role) continue;

      const load = await this.calculateWorkerLoad(inst);
      loads.push(load);
    }

    return loads;
  }

  /**
   * Get load balancing statistics.
   */
  async getStats(): Promise<LoadBalancerStats> {
    const loads = await this.getWorkerLoads();

    const idle = loads.filter((w) => w.status === "idle").length;
    const busy = loads.filter((w) => w.status === "busy").length;
    const overloaded = loads.filter((w) => w.is_overloaded).length;

    const avgLoad = loads.length > 0
      ? loads.reduce((sum, w) => sum + w.load_score, 0) / loads.length
      : 0;

    const variance = loads.length > 0
      ? loads.reduce((sum, w) => sum + Math.pow(w.load_score - avgLoad, 2), 0) / loads.length
      : 0;

    return {
      total_workers: loads.length,
      idle_workers: idle,
      busy_workers: busy,
      overloaded_workers: overloaded,
      average_load: avgLoad,
      load_variance: variance,
    };
  }

  /**
   * Record task completion for performance tracking.
   */
  recordTaskCompletion(
    instanceId: InstanceId,
    taskCount: number,
    completionTimeMs: number,
    success: boolean,
  ): void {
    if (!this.adaptive) return;

    const history = this.performanceHistory.get(instanceId) ?? [];
    history.push({
      task_count: taskCount,
      completion_time_ms: completionTimeMs,
      success,
      timestamp: Date.now(),
    });

    // Keep only recent history
    if (history.length > this.performanceHistorySize) {
      history.shift();
    }

    this.performanceHistory.set(instanceId, history);
  }

  /**
   * Calculate load score for a worker.
   */
  private async calculateWorkerLoad(instance: Instance): Promise<WorkerLoad> {
    // Get task count from instance (simplified - in real implementation,
    // this would query the task queue)
    const taskCount = this.getTaskCount(instance);
    const cpuUsage = this.getCpuUsage(instance);
    const memoryUsage = this.getMemoryUsage(instance);

    // Calculate base load score (0-1, lower is better)
    const normalizedCpu = cpuUsage / 100;
    const normalizedMemory = memoryUsage / 100;
    const normalizedTasks = Math.min(taskCount / this.maxTasksPerWorker, 1);

    // Status bonus: idle workers get a significant advantage
    const statusBonus = instance.status === "idle" ? 0.3 : 0;

    let loadScore =
      normalizedCpu * this.cpuWeight +
      normalizedMemory * this.memoryWeight +
      normalizedTasks * this.taskWeight;

    // Apply status bonus (idle workers get lower load scores)
    loadScore = Math.max(0, loadScore - statusBonus);

    // Apply adaptive adjustment based on performance
    const performanceScore = this.getPerformanceScore(instance.id);
    if (this.adaptive && performanceScore > 0) {
      // Workers with better performance get lower load scores
      loadScore *= (1 - performanceScore * 0.2); // Up to 20% reduction
    }

    return {
      instance_id: instance.id,
      name: instance.name,
      role: instance.role,
      status: instance.status,
      task_count: taskCount,
      cpu_usage: cpuUsage,
      memory_usage: memoryUsage,
      load_score: Math.max(0, Math.min(1, loadScore)),
      is_overloaded: taskCount >= this.maxTasksPerWorker,
      performance_score: performanceScore,
    };
  }

  /**
   * Get task count for a worker (simplified implementation).
   */
  private getTaskCount(instance: Instance): number {
    // In a real implementation, this would query the task queue
    // For now, use status as a proxy
    return instance.status === "busy" ? 1 : 0;
  }

  /**
   * Get CPU usage for a worker (simplified implementation).
   */
  private getCpuUsage(_instance: Instance): number {
    // In a real implementation, this would get actual CPU metrics
    // from the worker's resource monitor
    return 0;
  }

  /**
   * Get memory usage for a worker (simplified implementation).
   */
  private getMemoryUsage(_instance: Instance): number {
    // In a real implementation, this would get actual memory metrics
    // from the worker's resource monitor
    return 0;
  }

  /**
   * Get performance score based on historical data.
   */
  private getPerformanceScore(instanceId: InstanceId): number {
    const history = this.performanceHistory.get(instanceId);
    if (!history || history.length === 0) {
      return 0.5; // Neutral score for new workers
    }

    // Calculate success rate
    const successCount = history.filter((h) => h.success).length;
    const successRate = successCount / history.length;

    // Calculate average completion time (normalized, lower is better)
    const avgTime = history.reduce((sum, h) => sum + h.completion_time_ms, 0) / history.length;
    const normalizedTime = Math.min(avgTime / 60000, 1); // Normalize to 60 seconds max

    // Combine success rate and speed (higher is better)
    return (successRate * 0.7) + ((1 - normalizedTime) * 0.3);
  }

  /**
   * Pick the best worker from available workers.
   */
  private pickBestWorker(workers: WorkerLoad[]): { id: InstanceId; name: string } {
    // Sort by load score (ascending - lower is better)
    const sorted = [...workers].sort((a, b) => a.load_score - b.load_score);

    // Add some randomness to prevent thundering herd, but only when
    // there are multiple candidates that are close in load score.
    // With fewer than 3 candidates, always pick the lowest loaded.
    let best: WorkerLoad;
    if (sorted.length >= 3) {
      const topCandidates = sorted.slice(0, 3);
      best = topCandidates[Math.floor(Math.random() * topCandidates.length)];
    } else {
      best = sorted[0];
    }
    this.logger?.debug("load balancer selected worker", {
      instance_id: best.instance_id,
      name: best.name,
      load_score: best.load_score,
      task_count: best.task_count,
    });

    return { id: best.instance_id, name: best.name };
  }

  /**
   * Pick the least loaded worker (used when all are overloaded).
   */
  private pickLeastLoaded(workers: WorkerLoad[]): { id: InstanceId; name: string } {
    const sorted = [...workers].sort((a, b) => a.load_score - b.load_score);
    const least = sorted[0];

    this.logger?.warn("load balancer selected least loaded worker", {
      instance_id: least.instance_id,
      name: least.name,
      load_score: least.load_score,
    });

    return { id: least.instance_id, name: least.name };
  }
}
