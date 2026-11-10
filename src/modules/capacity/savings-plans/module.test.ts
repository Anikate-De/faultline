import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, savingsPlansModel } from "./module";

const model = savingsPlansModel;
const presets = module.sims["savings-plans"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;

describe("capacity-savings-plans model", () => {
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

  it("crosses critical within 45 simulated seconds when usage falls below the commitment", () => {
    const frame = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "commitment-shortfall")?.value).toBeGreaterThan(40);
    expect(frame.metrics.find((item) => item.id === "waste-cost")?.value).toBeGreaterThan(20);
    expect(frame.metrics.find((item) => item.id === "cost-to-ondemand")?.value).toBeGreaterThan(130);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("under-commitment leaves savings on the table without failing the plan", () => {
    const frame = runModel(model, params("peak"), 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(frame.metrics.find((item) => item.id === "on-demand-excess")?.value).toBeGreaterThan(12);
    expect(frame.metrics.find((item) => item.id === "waste-cost")?.value).toBe(0);
  });

  it("compares the over-committed bill with on-demand for actual usage", () => {
    const frame = runModel(model, params("failure"), 20261110, 45);
    const ratio = frame.metrics.find((item) => item.id === "cost-to-ondemand")?.value ?? 0;
    const cost = frame.metrics.find((item) => item.id === "monthly-cost")?.value ?? 0;
    expect(ratio).toBeGreaterThan(100);
    expect(cost).toBeGreaterThan(30);
  });

  it("emits the usage-below-commitment event once", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "usage-below-commitment")).toHaveLength(1);
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
