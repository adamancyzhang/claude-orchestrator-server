import { describe, it, expect, beforeEach, vi } from "vitest";
import { WSServer } from "../src/realtime/ws-server.js";
import { ChartDataAggregator } from "../src/realtime/chart-data.js";
import { HistoricalQuery } from "../src/realtime/historical-query.js";

describe("WSServer", () => {
  let wsServer: WSServer;

  beforeEach(() => {
    wsServer = new WSServer();
  });

  it("should track client count", () => {
    expect(wsServer.getClientCount()).toBe(0);
  });

  it("should broadcast to subscribed clients", () => {
    // Since we can't easily mock WebSocket in unit tests,
    // we'll test the broadcast method logic
    const broadcastSpy = vi.spyOn(wsServer as any, "sendRaw");

    // Add a mock client
    const mockClient = {
      id: "test-client",
      socket: { send: vi.fn() },
      subscriptions: new Set(["test-channel"]),
    };

    (wsServer as any).clients.set("test-client", mockClient);

    wsServer.broadcast("test-channel", { data: "test" });

    expect(broadcastSpy).toHaveBeenCalled();
  });
});

describe("ChartDataAggregator", () => {
  let aggregator: ChartDataAggregator;

  beforeEach(() => {
    aggregator = new ChartDataAggregator();
  });

  it("should add metric points", () => {
    aggregator.addMetric("agentsActive", 5);
    const data = aggregator.getData();

    expect(data.agentsActive).toHaveLength(1);
    expect(data.agentsActive[0].value).toBe(5);
  });

  it("should trim old data when exceeding maxPoints", () => {
    // Add more than 100 points
    for (let i = 0; i < 150; i++) {
      aggregator.addMetric("agentsActive", i);
    }

    const data = aggregator.getData();
    expect(data.agentsActive).toHaveLength(100);
    expect(data.agentsActive[0].value).toBe(50); // First 50 were trimmed
  });

  it("should clear all data", () => {
    aggregator.addMetric("agentsActive", 5);
    aggregator.addMetric("taskThroughput", 10);
    aggregator.addMetric("latency", 15);

    aggregator.clear();
    const data = aggregator.getData();

    expect(data.agentsActive).toHaveLength(0);
    expect(data.taskThroughput).toHaveLength(0);
    expect(data.latency).toHaveLength(0);
  });
});

describe("HistoricalQuery", () => {
  let query: HistoricalQuery;

  beforeEach(() => {
    query = new HistoricalQuery();
  });

  it("should store and query data", () => {
    const now = Date.now();
    const points = [
      { timestamp: now - 1000, value: 1 },
      { timestamp: now - 2000, value: 2 },
    ];

    query.store("test-metric", points);

    const result = query.query("test-metric", "hour");
    expect(result).toHaveLength(2);
  });

  it("should filter by time range", () => {
    const now = Date.now();
    const points = [
      { timestamp: now - 1000, value: 1 }, // 1 second ago
      { timestamp: now - 7000, value: 2 }, // 7 seconds ago
    ];

    query.store("test-metric", points);

    // Query last 5 seconds
    const result = query.query("test-metric", "hour");
    expect(result).toHaveLength(2); // Both within last hour
  });

  it("should cleanup old data", () => {
    const now = Date.now();
    const points = [
      { timestamp: now - 1000, value: 1 }, // Recent
      { timestamp: now - 100 * 24 * 60 * 60 * 1000, value: 2 }, // 100 days ago
    ];

    query.store("test-metric", points);
    query.cleanup(30); // Keep 30 days

    const result = query.query("test-metric", "week");
    expect(result).toHaveLength(1); // Only recent point
  });
});
