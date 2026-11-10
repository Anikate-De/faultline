import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { headroomCostModel, module } from "./module";

const model = headroomCostModel;
const presets = module.sims["headroom-cost"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;

describe("capacity-headroom-cost model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 45);
    const b = runModel(model, params("failure"), 42, 45);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative values", () => {
    const frame = runModel(model, params("failure"), 7, 90);
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

  it("is healthy at t=0 and through the healthy preset", () => {
    expect(activeThreshold(initModel(model, params("healthy"), 20261110), model.thresholds)).toBeNull();
    expect(activeNodeIncident(initModel(model, params("healthy"), 20261110))).toBeNull();
    expect(activeThreshold(runModel(model, params("healthy"), 20261110, 45), model.thresholds)).toBeNull();
  });

  it("looks healthy before the AZ loss and fails within 60 seconds", () => {
    const before = runModel(model, params("failure"), 20261110, 24);
    const after = runModel(model, params("failure"), 20261110, 40);
    expect(activeThreshold(before, model.thresholds)).toBeNull();
    expect(activeThreshold(after, model.thresholds)?.severity).toBe("crit");
    expect(after.metrics.find((item) => item.id === "fleet-utilization")?.value).toBeGreaterThan(95);
    expect(after.metrics.find((item) => item.id === "error-rate")?.value).toBeGreaterThan(5);
  });

  it("warns before the failure when one-AZ survival is exhausted", () => {
    const frame = runModel(model, params("failure"), 20261110, 1);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)?.severity).toBe("warn");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("shows that exact N+1 survives the arithmetic but not the SLO", () => {
    const frame = runModel(model, params("n-plus-one"), 20261110, 40);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "n1-utilization")?.value).toBeGreaterThanOrEqual(95);
    expect(frame.metrics.find((item) => item.id === "n1-utilization")?.value).toBeLessThanOrEqual(110);
  });

  it("the recovery fleet costs more than exact N+1", () => {
    const exact = runModel(model, params("n-plus-one"), 20261110, 40);
    const recovery = runModel(model, params("recovery"), 20261110, 40);
    const cost = (frame: typeof exact) => frame.metrics.find((item) => item.id === "monthly-cost")?.value ?? 0;
    expect(cost(recovery)).toBeGreaterThan(cost(exact));
  });

  it("emits the AZ failure and N+1 risk events once", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "az-failure")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "n1-risk")).toHaveLength(1);
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
    expect(model.params.length).toBe(4);
    expect(presets.length).toBe(5);
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
