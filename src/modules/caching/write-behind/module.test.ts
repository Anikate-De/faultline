import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, writeBehindModel as model } from "./module";

const presets = module.sims["write-behind"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("caching-write-behind model", () => {
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

  it("crosses the critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(metric(frame, "lost-writes")).toBeGreaterThan(100);
    expect(frame.events.some((event) => event.id === "threshold-lost-writes-crit")).toBe(true);
    expect(activeThreshold(frame, model.thresholds)?.threshold.id).toBe("lost-writes");
  });

  it("marks the flush path critical when reorder risk reaches forty percent", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), writeRps: 4_000, flushConcurrency: 5 },
      20261110,
      5,
    );
    const flush = frame.nodes.find((node) => node.id === "flush");
    expect(metric(frame, "reorder-risk")).toBeGreaterThanOrEqual(40);
    expect(flush?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("sizes the loss window from write rate and flush delay", () => {
    const frame = runModel(model, params("failure"), 20261110, 5);
    expect(metric(frame, "records-at-risk")).toBeCloseTo(8_000, -2);
    expect(metric(frame, "lost-writes")).toBeCloseTo(8_000, -2);
  });

  it("shrinking the flush window reduces risk without changing the acknowledgement path", () => {
    const failure = runModel(model, params("failure"), 20261110, 20);
    const recovery = runModel(model, params("recovery"), 20261110, 20);
    expect(metric(recovery, "records-at-risk")).toBeLessThan(
      metric(failure, "records-at-risk") / 20,
    );
    expect(metric(recovery, "lost-writes")).toBe(0);
    expect(metric(recovery, "write-p99")).toBeCloseTo(1.2, 1);
    expect(metric(recovery, "reorder-risk")).toBe(0);
  });

  it("fires the crash event once while the cache remains crashed", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    const events = frame.events.filter((event) => event.id === "write-behind-crash");
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
    expect(presets.length).toBe(4);
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
