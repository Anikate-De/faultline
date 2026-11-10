import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { asideVsWriteThroughModel as model, module } from "./module";

const presets = module.sims["aside-vs-write-through"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const maxMetric = (id: string, metricId: string, seconds = 30) => {
  let frame = initModel(model, params(id), 20261110);
  const rng = createRng(20261110);
  let max = 0;
  for (let index = 0; index < seconds / TICK; index++) {
    frame = stepModel(model, frame, params(id), rng);
    max = Math.max(max, metric(frame, metricId));
  }
  return max;
};

describe("caching-aside-vs-write-through model", () => {
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

  it("loads healthy at t=0 with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
  });

  it("crosses the critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(maxMetric("failure", "db-qps", 30)).toBeGreaterThan(9_000);
    expect(frame.events.some((event) => event.id === "threshold-write-errors-crit")).toBe(true);
    expect(activeThreshold(frame, model.thresholds)?.threshold.id).toBe("write-errors");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("write-through removes stale reads and doubles write operations", () => {
    const aside = runModel(model, params("stale-reads"), 20261110, 20);
    const through = runModel(model, { ...params("stale-reads"), strategy: 1 }, 20261110, 20);
    expect(metric(aside, "stale-reads")).toBeGreaterThan(30);
    expect(metric(through, "stale-reads")).toBe(0);
    expect(metric(through, "write-ops")).toBe(metric(aside, "write-ops") * 2);
  });

  it("cache-aside keeps writes successful during a cache outage while write-through fails closed", () => {
    const aside = runModel(
      model,
      { ...params("healthy"), writeRps: 2_000, cacheUp: 0 },
      20261110,
      20,
    );
    const through = runModel(
      model,
      { ...params("healthy"), strategy: 1, writeRps: 2_000, cacheUp: 0 },
      20261110,
      20,
    );
    expect(metric(aside, "write-errors")).toBe(0);
    expect(metric(through, "write-errors")).toBe(100);
    expect(metric(aside, "db-qps")).toBeGreaterThan(9_000);
  });

  it("fires the write-through failure event once during the outage", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    const events = frame.events.filter((event) => event.id === "write-through-failed-closed");
    expect(events.length).toBe(1);
    expect(events[0].severity).toBe("crit");
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
      const other = stepped.metrics.find((entry) => entry.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(4);
    expect(presets.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
