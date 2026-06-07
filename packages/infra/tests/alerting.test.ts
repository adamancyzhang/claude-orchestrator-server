import { describe, expect, it, vi } from "vitest";
import {
  AlertManager,
  AlertHistory,
  LogNotifier,
  evaluateCondition,
  createRuntimeState,
  toSnapshot,
  type AlertRuleConfig,
  type AlertEvent,
} from "../src/alerting/index.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeRule(overrides: Partial<AlertRuleConfig> = {}): AlertRuleConfig {
  return {
    id: "test-rule",
    name: "Test Rule",
    description: "A test rule",
    severity: "warning",
    metricValue: () => 0,
    threshold: 10,
    operator: "gt",
    durationMs: 0, // Instant fire for most tests.
    ...overrides,
  };
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

// ── evaluateCondition ─────────────────────────────────────────────────

describe("evaluateCondition", () => {
  it("gt", () => {
    expect(evaluateCondition(11, "gt", 10)).toBe(true);
    expect(evaluateCondition(10, "gt", 10)).toBe(false);
    expect(evaluateCondition(9, "gt", 10)).toBe(false);
  });

  it("gte", () => {
    expect(evaluateCondition(11, "gte", 10)).toBe(true);
    expect(evaluateCondition(10, "gte", 10)).toBe(true);
    expect(evaluateCondition(9, "gte", 10)).toBe(false);
  });

  it("lt", () => {
    expect(evaluateCondition(9, "lt", 10)).toBe(true);
    expect(evaluateCondition(10, "lt", 10)).toBe(false);
    expect(evaluateCondition(11, "lt", 10)).toBe(false);
  });

  it("lte", () => {
    expect(evaluateCondition(9, "lte", 10)).toBe(true);
    expect(evaluateCondition(10, "lte", 10)).toBe(true);
    expect(evaluateCondition(11, "lte", 10)).toBe(false);
  });

  it("eq", () => {
    expect(evaluateCondition(10, "eq", 10)).toBe(true);
    expect(evaluateCondition(11, "eq", 10)).toBe(false);
  });
});

// ── AlertHistory ──────────────────────────────────────────────────────

describe("AlertHistory", () => {
  it("records entries", () => {
    const history = new AlertHistory();
    const event: AlertEvent = {
      rule: {
        id: "r1", name: "R1", description: "", severity: "warning",
        state: "firing", currentValue: 15, threshold: 10, operator: "gt",
        triggeredAt: 1, firedAt: 2, resolvedAt: null,
      },
      transition: "firing",
      timestamp: 1000,
    };
    history.record(event);
    expect(history.count()).toBe(1);
    expect(history.getEntries()[0].ruleId).toBe("r1");
  });

  it("filters by ruleId", () => {
    const history = new AlertHistory();
    const makeEvent = (id: string): AlertEvent => ({
      rule: {
        id, name: id, description: "", severity: "warning",
        state: "firing", currentValue: 0, threshold: 0, operator: "gt",
        triggeredAt: null, firedAt: null, resolvedAt: null,
      },
      transition: "firing",
      timestamp: 1000,
    });
    history.record(makeEvent("r1"));
    history.record(makeEvent("r2"));
    history.record(makeEvent("r1"));
    expect(history.getEntries("r1")).toHaveLength(2);
    expect(history.getEntries("r2")).toHaveLength(1);
  });

  it("evicts oldest entries when over max size", () => {
    const history = new AlertHistory(3);
    const makeEvent = (ts: number): AlertEvent => ({
      rule: {
        id: "r1", name: "R1", description: "", severity: "warning",
        state: "firing", currentValue: 0, threshold: 0, operator: "gt",
        triggeredAt: null, firedAt: null, resolvedAt: null,
      },
      transition: "firing",
      timestamp: ts,
    });
    history.record(makeEvent(1));
    history.record(makeEvent(2));
    history.record(makeEvent(3));
    history.record(makeEvent(4));
    expect(history.count()).toBe(3);
    expect(history.getEntries()[0].timestamp).toBe(2);
  });

  it("clears all entries", () => {
    const history = new AlertHistory();
    history.record({
      rule: {
        id: "r1", name: "R1", description: "", severity: "warning",
        state: "firing", currentValue: 0, threshold: 0, operator: "gt",
        triggeredAt: null, firedAt: null, resolvedAt: null,
      },
      transition: "firing",
      timestamp: 1000,
    });
    history.clear();
    expect(history.count()).toBe(0);
  });
});

// ── LogNotifier ───────────────────────────────────────────────────────

describe("LogNotifier", () => {
  it("logs firing alerts", async () => {
    const warn = vi.fn();
    const logger = { ...noopLogger, warn };
    const notifier = new LogNotifier(logger);
    await notifier.notify({
      rule: {
        id: "r1", name: "High CPU", description: "CPU too high",
        severity: "warning", state: "firing", currentValue: 95,
        threshold: 80, operator: "gt", triggeredAt: 1, firedAt: 2,
        resolvedAt: null,
      },
      transition: "firing",
      timestamp: 1000,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("High CPU");
  });

  it("logs resolved alerts as info", async () => {
    const info = vi.fn();
    const logger = { ...noopLogger, info };
    const notifier = new LogNotifier(logger);
    await notifier.notify({
      rule: {
        id: "r1", name: "High CPU", description: "CPU too high",
        severity: "warning", state: "resolved", currentValue: 50,
        threshold: 80, operator: "gt", triggeredAt: 1, firedAt: 2,
        resolvedAt: 3,
      },
      transition: "resolved",
      timestamp: 3000,
    });
    expect(info).toHaveBeenCalledOnce();
  });

  it("logs critical firing alerts as error", async () => {
    const error = vi.fn();
    const logger = { ...noopLogger, error };
    const notifier = new LogNotifier(logger);
    await notifier.notify({
      rule: {
        id: "r1", name: "Out of memory", description: "OOM",
        severity: "critical", state: "firing", currentValue: 99,
        threshold: 90, operator: "gt", triggeredAt: 1, firedAt: 2,
        resolvedAt: null,
      },
      transition: "firing",
      timestamp: 1000,
    });
    expect(error).toHaveBeenCalledOnce();
  });
});

// ── AlertManager ──────────────────────────────────────────────────────

describe("AlertManager", () => {
  it("registers and retrieves rules", () => {
    const manager = new AlertManager();
    manager.addRule(makeRule({ id: "r1" }));
    manager.addRule(makeRule({ id: "r2" }));

    expect(manager.getRule("r1")).toBeDefined();
    expect(manager.getRule("r2")).toBeDefined();
    expect(manager.getAllRules()).toHaveLength(2);
  });

  it("throws on duplicate rule ID", () => {
    const manager = new AlertManager();
    manager.addRule(makeRule({ id: "r1" }));
    expect(() => manager.addRule(makeRule({ id: "r1" }))).toThrow(
      /already registered/,
    );
  });

  it("removes rules", () => {
    const manager = new AlertManager();
    manager.addRule(makeRule({ id: "r1" }));
    expect(manager.removeRule("r1")).toBe(true);
    expect(manager.getRule("r1")).toBeUndefined();
    expect(manager.removeRule("nonexistent")).toBe(false);
  });

  it("fires alert when condition is met with zero duration", async () => {
    let value = 15;
    const manager = new AlertManager({ logger: noopLogger });
    manager.addRule(
      makeRule({ id: "r1", metricValue: () => value, threshold: 10, operator: "gt", durationMs: 0 }),
    );

    await manager.evaluate(); // ok → pending
    await manager.evaluate(); // pending → firing (durationMs=0 satisfied immediately)

    const rule = manager.getRule("r1")!;
    expect(rule.state).toBe("firing");
    expect(rule.currentValue).toBe(15);
    expect(rule.firedAt).toBeTypeOf("number");
  });

  it("stays ok when condition is not met", async () => {
    const manager = new AlertManager({ logger: noopLogger });
    manager.addRule(
      makeRule({ id: "r1", metricValue: () => 5, threshold: 10, operator: "gt", durationMs: 0 }),
    );

    await manager.evaluate();

    expect(manager.getRule("r1")!.state).toBe("ok");
  });

  it("transitions from firing to resolved when condition clears", async () => {
    let value = 15;
    const manager = new AlertManager({ logger: noopLogger });
    manager.addRule(
      makeRule({ id: "r1", metricValue: () => value, threshold: 10, operator: "gt", durationMs: 0 }),
    );

    await manager.evaluate(); // ok → pending
    await manager.evaluate(); // pending → firing
    expect(manager.getRule("r1")!.state).toBe("firing");

    value = 5;
    await manager.evaluate(); // firing → resolved
    expect(manager.getRule("r1")!.state).toBe("resolved");
  });

  it("respects duration before firing", async () => {
    let value = 15;
    const manager = new AlertManager({ logger: noopLogger });
    manager.addRule(
      makeRule({ id: "r1", metricValue: () => value, threshold: 10, operator: "gt", durationMs: 5000 }),
    );

    await manager.evaluate();
    expect(manager.getRule("r1")!.state).toBe("pending");

    // Not enough time has passed.
    await manager.evaluate();
    expect(manager.getRule("r1")!.state).toBe("pending");
  });

  it("reverts to ok if condition clears during pending", async () => {
    let value = 15;
    const manager = new AlertManager({ logger: noopLogger });
    manager.addRule(
      makeRule({ id: "r1", metricValue: () => value, threshold: 10, operator: "gt", durationMs: 5000 }),
    );

    await manager.evaluate();
    expect(manager.getRule("r1")!.state).toBe("pending");

    value = 5;
    await manager.evaluate();
    expect(manager.getRule("r1")!.state).toBe("ok");
  });

  it("calls notifiers on state transitions", async () => {
    let value = 15;
    const notifyFn = vi.fn();
    const notifier = {
      name: "test",
      notify: notifyFn,
    };
    const manager = new AlertManager({ logger: noopLogger, notifiers: [notifier] });
    manager.addRule(
      makeRule({ id: "r1", metricValue: () => value, threshold: 10, operator: "gt", durationMs: 0 }),
    );

    await manager.evaluate(); // ok → pending
    await manager.evaluate(); // pending → firing
    expect(notifyFn).toHaveBeenCalledTimes(1);
    expect(notifyFn.mock.calls[0][0].transition).toBe("firing");

    value = 5;
    await manager.evaluate(); // firing → resolved
    expect(notifyFn).toHaveBeenCalledTimes(2);
    expect(notifyFn.mock.calls[1][0].transition).toBe("resolved");
  });

  it("records history on transitions", async () => {
    let value = 15;
    const manager = new AlertManager({ logger: noopLogger });
    manager.addRule(
      makeRule({ id: "r1", metricValue: () => value, threshold: 10, operator: "gt", durationMs: 0 }),
    );

    await manager.evaluate(); // ok → pending (no history entry)
    await manager.evaluate(); // pending → firing (history entry)
    expect(manager.getHistory()).toHaveLength(1);

    value = 5;
    await manager.evaluate(); // firing → resolved (history entry)
    expect(manager.getHistory()).toHaveLength(2);
  });

  it("filters rules by state", async () => {
    let value = 15;
    const manager = new AlertManager({ logger: noopLogger });
    manager.addRule(
      makeRule({ id: "r1", metricValue: () => value, threshold: 10, operator: "gt", durationMs: 0 }),
    );
    manager.addRule(
      makeRule({ id: "r2", metricValue: () => 3, threshold: 10, operator: "gt", durationMs: 0 }),
    );

    await manager.evaluate(); // ok → pending for r1
    await manager.evaluate(); // pending → firing for r1

    expect(manager.getRulesByState("firing")).toHaveLength(1);
    expect(manager.getRulesByState("ok")).toHaveLength(1);
  });

  it("continues notifying other rules when one notifier fails", async () => {
    let value = 15;
    const badNotifier = {
      name: "bad",
      notify: vi.fn().mockRejectedValue(new Error("network error")),
    };
    const goodNotifier = {
      name: "good",
      notify: vi.fn().mockResolvedValue(undefined),
    };
    const logger = { ...noopLogger, error: vi.fn() };
    const manager = new AlertManager({ logger, notifiers: [badNotifier, goodNotifier] });
    manager.addRule(
      makeRule({ id: "r1", metricValue: () => value, threshold: 10, operator: "gt", durationMs: 0 }),
    );

    await manager.evaluate(); // ok → pending
    await manager.evaluate(); // pending → firing

    expect(badNotifier.notify).toHaveBeenCalledOnce();
    expect(goodNotifier.notify).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalled(); // The error from badNotifier
  });
});

// ── createRuntimeState / toSnapshot ───────────────────────────────────

describe("createRuntimeState and toSnapshot", () => {
  it("creates initial state from rule", () => {
    const rule = makeRule({ metricValue: () => 42 });
    const state = createRuntimeState(rule);
    expect(state.state).toBe("ok");
    expect(state.currentValue).toBe(42);
    expect(state.firedAt).toBeNull();
  });

  it("serializes state to snapshot", () => {
    const rule = makeRule();
    const state = createRuntimeState(rule);
    state.state = "firing";
    state.firedAt = 1000;
    const snapshot = toSnapshot(state);
    expect(snapshot.state).toBe("firing");
    expect(snapshot.firedAt).toBe(1000);
    expect(snapshot.id).toBe(rule.id);
  });
});
