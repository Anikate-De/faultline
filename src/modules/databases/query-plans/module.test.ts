import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, queryPlanModel } from "./module";

const model = queryPlanModel;
const presets = module.sims["query-plans"].presets;
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

describe("databases-query-plans model", () => {
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

  it("crosses critical thresholds within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "read-p95")).toBeCloseTo(4_000.4, 6);
    expect(metricValue(frame, "rows-examined")).toBe(1_000_000);
    expect(metricValue(frame, "estimated-rows")).toBe(20_000);
    expect(node(frame, "planner")?.health).toBe("crit");
    expect(node(frame, "table")?.health).toBe("crit");
    expect(frame.summary).toContain("nested loop");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "read-p95")).toBeCloseTo(40.4, 6);
    expect(metricValue(frame, "rows-examined")).toBe(10_000);
    expect(metricValue(frame, "estimated-rows")).toBe(10_000);
    expect(node(frame, "planner")?.health).toBe("ok");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-query-latency-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "threshold-rows-examined-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "stale-statistics").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "nested-loop").length).toBe(1);
  });

  it("fixes the same query by refreshing statistics", () => {
    const base = { ...params("healthy"), rowCount: 2_000_000, selectivity: 2 };
    const stale = runModel(model, { ...base, statsAgeDays: 21, statsTarget: 20 }, 20261110, 20);
    const fresh = runModel(model, { ...base, statsAgeDays: 0, statsTarget: 200 }, 20261110, 20);
    expect(metricValue(stale, "estimated-rows")).toBe(800);
    expect(metricValue(stale, "read-p95")).toBeCloseTo(160.4, 6);
    expect(metricValue(fresh, "estimated-rows")).toBe(40_000);
    expect(metricValue(fresh, "read-p95")).toBeCloseTo(42, 6);
    expect(metricValue(fresh, "read-p95")).toBeLessThan(metricValue(stale, "read-p95"));
    expect(stale.summary).toContain("nested loop");
    expect(fresh.summary).toContain("index scan");
  });

  it("falls back to a sequential scan when the predicate wraps the column", () => {
    const frame = runModel(model, { ...params("wrapped") }, 20261110, 20);
    expect(metricValue(frame, "read-p95")).toBeCloseTo(31, 6);
    expect(metricValue(frame, "rows-examined")).toBe(300_000);
    expect(metricValue(frame, "estimated-rows")).toBeCloseTo(14_510, 0);
    expect(node(frame, "index")?.health).toBe("warn");
    expect(frame.summary).toContain("sequential scan");
  });

  it("warns rather than fails when the table grows but statistics are current", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(metricValue(frame, "read-p95")).toBeCloseTo(202, 6);
    expect(metricValue(frame, "rows-examined")).toBe(200_000);
    expect(node(frame, "table")?.health).toBe("warn");
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
    expect(module.sims["query-plans"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
