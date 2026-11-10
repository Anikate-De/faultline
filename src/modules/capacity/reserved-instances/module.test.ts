import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, reservedInstancesModel } from "./module";

const model = reservedInstancesModel;
const presets = module.sims["reserved-instances"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;

describe("capacity-reserved-instances model", () => {
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

  it("crosses critical within 45 simulated seconds when the family drifts", () => {
    const frame = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "effective-coverage")?.value).toBeLessThan(40);
    expect(frame.metrics.find((item) => item.id === "waste-cost")?.value).toBeGreaterThan(5);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("headline coverage stays high while effective coverage falls", () => {
    const frame = runModel(model, params("failure"), 20261110, 45);
    const coverage = frame.metrics.find((item) => item.id === "effective-coverage")?.value ?? 0;
    expect(params("failure").coveragePct).toBe(80);
    expect(coverage).toBeLessThan(40);
    expect(frame.metrics.find((item) => item.id === "excess-cost")?.value).toBeGreaterThan(2);
  });

  it("a longer term strands more cost at the same monthly waste", () => {
    const long = runModel(model, params("failure"), 20261110, 45);
    const short = runModel(model, params("term"), 20261110, 45);
    const waste = (frame: typeof long) => frame.metrics.find((item) => item.id === "waste-cost")?.value ?? 0;
    const stranded = (frame: typeof long) => frame.metrics.find((item) => item.id === "stranded-cost")?.value ?? 0;
    expect(waste(long)).toBeCloseTo(waste(short), 5);
    expect(stranded(long)).toBeGreaterThan(stranded(short) * 2);
  });

  it("emits the migration and mismatch events once", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "family-migration")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "commitment-mismatch")).toHaveLength(1);
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
