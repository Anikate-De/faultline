import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { dataClassificationModel, module } from "./module";

const model = dataClassificationModel;
const presets = module.sims["data-classification"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("compliance-data-classification model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "sensitive-exposure")).toBe(0);
    expect(value(frame, "readiness-floor")).toBe(100);
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
    for (const series of Object.values(frame.series)) {
      for (const item of series) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(activeNodeIncident(frame)?.severity).toBe("crit");
    expect(value(frame, "sensitive-exposure")).toBeGreaterThanOrEqual(35);
    expect(value(frame, "inventory-gap")).toBeGreaterThanOrEqual(40);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "sensitive-exposure")).toBeLessThanOrEqual(10);
  });

  it("keeps one critical event per crossing when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-sensitive-exposure-crit")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "sensitive-under-public-controls")).toHaveLength(1);
  });

  it("treats a fully labeled mixed bucket as exposed", () => {
    const frame = runModel(model, { ...module.experiments[0].setup }, 20261110, 20);
    expect(value(frame, "sensitive-exposure")).toBe(100);
    expect(value(frame, "readiness-floor")).toBe(0);
    expect(frame.nodes.find((node) => node.id === "bucket")?.health).toBe("crit");
    expect(frame.nodes.find((node) => node.id === "public")?.health).toBe("ok");
  });

  it("does not let a matching label compensate for a weak control", () => {
    const frame = runModel(
      model,
      { inventory: 100, labels: 100, mixedHandling: 100, controlMatch: 0 },
      20261110,
      20,
    );
    expect(value(frame, "sensitive-exposure")).toBe(100);
    expect(frame.nodes.find((node) => node.id === "logs")?.health).toBe("crit");
    expect(frame.nodes.find((node) => node.id === "bucket")?.health).toBe("ok");
  });

  it("clears the model when the experiment fix is applied", () => {
    const frame = runModel(model, { ...module.experiments[0].fix }, 20261110, 20);
    expect(value(frame, "sensitive-exposure")).toBe(0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
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
      const other = stepped.metrics.find((metricValue) => metricValue.id === item.id);
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
