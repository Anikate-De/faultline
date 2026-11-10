import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, poolModel } from "./module";

const model = poolModel;
const presets = module.sims.pool.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((metric) => metric.id === id)?.value ?? 0;

describe("foundations-connection-pools model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative values", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const node of frame.nodes) {
      expect(Number.isFinite(node.utilization ?? 0)).toBe(true);
      expect(node.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(node.utilization ?? 0).toBeLessThanOrEqual(1);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses the pool-wait critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "pool-wait-p99")).toBeGreaterThan(500);
    expect(metricValue(frame, "pool-utilization")).toBeGreaterThan(90);
    expect(metricValue(frame, "db-connection-util")).toBeLessThan(75);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-pool-wait-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("shows that a larger pool reduces wait when the database has headroom", () => {
    const base = params("failure");
    const larger = { ...base, poolSize: 12, taskCount: 30 };
    const before = runModel(model, base, 6, 20);
    const after = runModel(model, larger, 6, 20);
    expect(metricValue(after, "pool-wait-p99")).toBeLessThan(metricValue(before, "pool-wait-p99"));
    expect(metricValue(after, "pool-utilization")).toBeLessThan(metricValue(before, "pool-utilization"));
    expect(metricValue(after, "db-connection-util")).toBeLessThan(90);
  });

  it("keeps pool wait continuous near saturation instead of jumping to the open timeout", () => {
    const heavy = { ...params("healthy"), rpsPerTask: 198, queryMs: 25, poolSize: 5 };
    const frame = runModel(model, heavy, 3, 20);
    const wait = metricValue(frame, "pool-wait-p99");
    expect(wait).toBeGreaterThan(1_000);
    expect(wait).toBeLessThan(10_000);
  });

  it("shows the database limit failing when task count multiplies sessions", () => {
    const frame = runModel(model, params("db-limit"), 8, 20);
    expect(metricValue(frame, "db-max-sessions")).toBe(1_800);
    expect(metricValue(frame, "db-connections")).toBeGreaterThan(500);
    expect(metricValue(frame, "db-connection-util")).toBeGreaterThan(90);
    expect(metricValue(frame, "pool-wait-p99")).toBeLessThan(500);
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
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
