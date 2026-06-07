export interface MetricPoint {
  timestamp: number;
  value: number;
}

export interface ChartData {
  agentsActive: MetricPoint[];
  taskThroughput: MetricPoint[];
  latency: MetricPoint[];
}

/**
 * Aggregates real-time metrics for chart display.
 */
export class ChartDataAggregator {
  private data: ChartData = {
    agentsActive: [],
    taskThroughput: [],
    latency: [],
  };

  private maxPoints = 100; // Keep last 100 points

  /**
   * Add a new metric point.
   */
  addMetric(metric: keyof ChartData, value: number): void {
    const point: MetricPoint = {
      timestamp: Date.now(),
      value,
    };

    this.data[metric].push(point);

    // Trim old data
    if (this.data[metric].length > this.maxPoints) {
      this.data[metric] = this.data[metric].slice(-this.maxPoints);
    }
  }

  /**
   * Get current chart data.
   */
  getData(): ChartData {
    return { ...this.data };
  }

  /**
   * Get data for a specific metric.
   */
  getMetricData(metric: keyof ChartData): MetricPoint[] {
    return [...this.data[metric]];
  }

  /**
   * Clear all data.
   */
  clear(): void {
    this.data = {
      agentsActive: [],
      taskThroughput: [],
      latency: [],
    };
  }
}
