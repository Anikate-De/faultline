import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, locksModel } from "./module";

const model = locksModel;
const presets = module.sims["locks-deadlocks"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const node = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.nodes.find((item) => item.id === id);

describe("databases-locks-deadlocks model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or out-of-range utilization", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const item of frame.nodes) {
      expect(Number.isFinite(item.utilization ?? 0)).toBe(true);
      expect(item.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(item.utilization ?? 0).toBeLessThanOrEqual(1);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "wait-p95")).toBeCloseTo(5_920, 6);
    expect(metricValue(frame, "deadlocks")).toBeCloseTo(10.8, 6);
    expect(metricValue(frame, "retry-multiplier")).toBeCloseTo(4.24, 6);
    expect(metricValue(frame, "blocked-sessions")).toBe(32);
    expect(node(frame, "row-lock")?.health).toBe("crit");
    expect(node(frame, "pool")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "deadlocks")).toBe(0);
    expect(metricValue(frame, "wait-p95")).toBeLessThan(300);
    expect(node(frame, "row-lock")?.health).toBe("ok");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-lock-wait-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "deadlock-detected").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "retry-storm").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "lock-monitor-ready").length).toBe(1);
  });

  it("removes deadlocks with consistent ordering but keeps some waiting", () => {
    const unordered = runModel(model, params("failure"), 20261110, 20);
    const ordered = runModel(model, { ...params("failure"), consistentOrder: 1 }, 20261110, 20);
    expect(metricValue(unordered, "deadlocks")).toBeGreaterThan(0);
    expect(metricValue(ordered, "deadlocks")).toBe(0);
    expect(metricValue(ordered, "wait-p95")).toBeGreaterThan(0);
    expect(metricValue(ordered, "wait-p95")).toBeLessThan(metricValue(unordered, "wait-p95"));
  });

  it("reduces retry amplification without changing the deadlock rate", () => {
    const immediate = runModel(model, { ...params("failure"), retryBackoff: 0 }, 20261110, 20);
    const backedOff = runModel(model, { ...params("failure"), retryBackoff: 1 }, 20261110, 20);
    expect(metricValue(backedOff, "retry-multiplier")).toBe(1);
    expect(metricValue(immediate, "retry-multiplier")).toBeGreaterThan(1);
    expect(metricValue(backedOff, "deadlocks")).toBeCloseTo(metricValue(immediate, "deadlocks"), 6);
  });

  it("grows the wait queue with lock hold time", () => {
    const short = runModel(model, { ...params("failure"), lockHoldMs: 100 }, 20261110, 20);
    const long = runModel(model, { ...params("failure"), lockHoldMs: 1_000 }, 20261110, 20);
    expect(metricValue(long, "wait-p95")).toBeGreaterThan(metricValue(short, "wait-p95"));
    expect(metricValue(long, "blocked-sessions")).toBeGreaterThan(metricValue(short, "blocked-sessions"));
  });

  it("flags a busy but ordered workload as a warning, not a deadlock storm", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(metricValue(frame, "deadlocks")).toBe(0);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(node(frame, "row-lock")?.health).toBe("ok");
    expect(node(frame, "session-a")?.health).toBe("warn");
    expect(node(frame, "session-b")?.health).toBe("warn");
  });

  it("runFor matches stepping the same number of ticks", () => {
    const seconds = 12;
    const fast = runModel(model, params("failure"), 99, seconds);
    let stepped = initModel(model, params("failure"), 99);
    const rng = createRng(99);
    for (let index = 0; index < seconds / TICK; index++) {
      stepped = stepModel(model, stepped, params("failure"), rng);
    }
    expect(stepped.t).toBeCloseTo(fast.t, 5);
    for (const item of fast.metrics) {
      const other = stepped.metrics.find((metric) => metric.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBeGreaterThanOrEqual(3);
    expect(model.params.length).toBeLessThanOrEqual(6);
    expect(module.sims["locks-deadlocks"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
