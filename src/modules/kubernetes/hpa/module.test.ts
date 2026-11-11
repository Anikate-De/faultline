import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { hpaModel, module } from "./module";

const model = hpaModel;
const presets = module.sims.hpa.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("kubernetes-hpa model", () => {
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

  it("scales to the maximum while the downstream database saturates", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "replicas")).toBe(30);
    expect(value(frame, "db-util")).toBeGreaterThan(90);
    expect(value(frame, "p99")).toBeGreaterThan(800);
    expect(value(frame, "app-cpu")).toBeGreaterThan(60);
    expect(value(frame, "app-cpu")).toBeLessThan(90);
  });

  it("starts healthy with no active threshold", () => {
    const frame = runModel(model, params("healthy"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "p99")).toBeLessThan(300);
  });

  it("relieves latency by raising database capacity, not the pod cap", () => {
    const fix = module.experiments[0].fix ?? {};
    const fixed = runModel(model, fix, 20261110, 20);
    expect(activeThreshold(fixed, model.thresholds)).toBeNull();
    expect(value(fixed, "p99")).toBeLessThan(300);
    expect(value(fixed, "db-util")).toBeLessThan(75);

    const morePods = runModel(model, { ...params("failure"), maxReplicas: 34 }, 20261110, 20);
    expect(activeThreshold(morePods, model.thresholds)?.severity).toBe("crit");
    expect(value(morePods, "db-util")).toBeGreaterThan(90);
  });

  it("warns at peak without reaching critical", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "replicas")).toBe(20);
    expect(value(frame, "db-util")).toBeGreaterThan(75);
    expect(value(frame, "db-util")).toBeLessThan(90);
  });

  it("keeps replicas low when the HPA watches a memory metric", () => {
    const frame = runModel(model, params("wrong-metric"), 20261110, 20);
    expect(value(frame, "replicas")).toBe(2);
    expect(value(frame, "app-cpu")).toBeGreaterThan(90);
    expect(value(frame, "p99")).toBeGreaterThan(800);
  });

  it("returns to ok within 60 seconds when downstream capacity is raised", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "db-util")).toBeLessThan(75);
    expect(value(frame, "p99")).toBeLessThan(300);
  });

  it("agrees with the database node utilization", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const database = frame.nodes.find((node) => node.id === "database");
    expect(database?.utilization).toBe(1);
    expect(database?.health).toBe("crit");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-p99-crit");
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
    expect(model.params).toHaveLength(5);
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
