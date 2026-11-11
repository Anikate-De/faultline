import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, pdbModel } from "./module";

const model = pdbModel;
const presets = module.sims.pdb.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("kubernetes-pdb model", () => {
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
      for (const item of values) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("loses two thirds of the service when the budget floor is zero", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "availability-gap")).toBeCloseTo(66.67, 1);
    expect(value(frame, "available-pods")).toBe(2);
    expect(value(frame, "evictions-denied")).toBe(0);
  });

  it("starts healthy with no active threshold", () => {
    const frame = runModel(model, params("healthy"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "evictions-denied")).toBe(0);
  });

  it("treats the PDB floor as a warning unless availability falls further", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), replicas: 6, minAvailable: 50, drainBatch: 2, unready: 2 },
      20261110,
      20,
    );
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "availability-gap")).toBe(50);
    expect(value(frame, "evictions-denied")).toBe(1);
  });

  it("denies a two-pod drain when an unready pod has consumed the budget", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "evictions-denied")).toBe(1);
    expect(value(frame, "allowed-disruptions")).toBe(1);
    expect(value(frame, "available-pods")).toBe(6);
  });

  it("returns to ok within 60 seconds with more replicas", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "availability-gap")).toBeLessThan(20);
    expect(value(frame, "evictions-denied")).toBe(0);
  });

  it("counts readiness, not pod objects, against the budget", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), unready: 2, drainBatch: 2 },
      20261110,
      20,
    );
    expect(value(frame, "allowed-disruptions")).toBe(1);
    expect(value(frame, "evictions-denied")).toBe(1);
    expect(value(frame, "available-pods")).toBe(3);
  });

  it("permits the whole healthy set when minAvailable is zero", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(value(frame, "allowed-disruptions")).toBe(6);
    expect(value(frame, "drain-progress")).toBe(100);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-availability-gap-crit");
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe("crit");
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
    expect(model.params).toHaveLength(4);
    expect(presets).toHaveLength(4);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
    const experiment = module.experiments[0];
    expect(experiment.prediction.options.some((option) => option.id === experiment.prediction.correctOptionId)).toBe(true);
  });
});
