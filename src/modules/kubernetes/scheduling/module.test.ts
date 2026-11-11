import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, schedulingModel } from "./module";

const model = schedulingModel;
const presets = module.sims.scheduling.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("kubernetes-scheduling model", () => {
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

  it("leaves pods Pending on an untolerated taint while filtered nodes keep free CPU", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "pending")).toBeGreaterThanOrEqual(3);
    expect(value(frame, "blocked-free-cpu")).toBeGreaterThanOrEqual(8_000);
    expect(value(frame, "eligible-free-cpu")).toBe(0);
    expect(frame.nodes.find((node) => node.id === "workload")?.health).toBe("crit");
  });

  it("matches the zone-affinity experiment counts", () => {
    const frame = runModel(model, module.experiments[0].setup, 20261110, 20);
    expect(value(frame, "eligible-nodes")).toBe(2);
    expect(value(frame, "pending")).toBe(4);
    expect(value(frame, "blocked-free-cpu")).toBe(8_000);
  });

  it("does not raise an incident for filtered capacity when nothing is Pending", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), replicas: 2, podCpu: 500, nodeCount: 4, constraint: 2 },
      20261110,
      20,
    );
    expect(value(frame, "blocked-free-cpu")).toBe(8_000);
    expect(value(frame, "stranded-cpu")).toBe(0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("starts healthy with no active threshold", () => {
    const frame = runModel(model, params("healthy"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "pending")).toBe(0);
  });

  it("warns without failing while eligible capacity runs high", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "pending")).toBe(0);
    expect(value(frame, "alloc-cpu")).toBeGreaterThan(85);
    expect(value(frame, "alloc-cpu")).toBeLessThan(90);
  });

  it("places every pod when the taint is tolerated", () => {
    const frame = runModel(model, params("toleration"), 20261110, 20);
    expect(value(frame, "pending")).toBe(0);
    expect(value(frame, "blocked-free-cpu")).toBe(0);
    expect(value(frame, "alloc-cpu")).toBe(75);
  });

  it("returns to ok within 60 seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "pending")).toBe(0);
    expect(value(frame, "alloc-cpu")).toBeLessThan(75);
  });

  it("counts only nodes that pass the placement rule as eligible", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(value(frame, "eligible-nodes")).toBe(2);
    const eligible = frame.nodes.filter((node) => node.meta?.blocked === 0);
    expect(eligible).toHaveLength(2);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-pending-crit");
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
    expect(presets).toHaveLength(5);
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
