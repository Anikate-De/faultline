import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { canaryMetricGateModel, module } from "./module";

const model = canaryMetricGateModel;
const presets = module.sims["canary-gate"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("deployment-canary-metric-gate model", () => {
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

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "dependency-utilization")).toBeGreaterThan(95);
    expect(metricValue(frame, "error-rate")).toBeGreaterThan(2);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "dependency-utilization")).toBeLessThan(85);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-dependency-utilization-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("canary passes while full rollout saturates the shared dependency", () => {
    const canary = runModel(model, params("canary-pass"), 20261110, 30);
    const full = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(canary, model.thresholds)).toBeNull();
    expect(metricValue(canary, "dependency-utilization")).toBeLessThan(85);
    expect(metricValue(full, "dependency-utilization")).toBeGreaterThan(metricValue(canary, "dependency-utilization"));
    expect(metricValue(full, "error-rate")).toBeGreaterThan(metricValue(canary, "error-rate"));
  });

  it("keeps app CPU healthy while the dependency is critical", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(metricValue(frame, "app-cpu")).toBeLessThan(75);
    expect(metricValue(frame, "dependency-utilization")).toBeGreaterThan(95);
  });

  it("detects an insufficient gate sample", () => {
    const frame = runModel(model, params("short-gate"), 20261110, 30);
    expect(metricValue(frame, "sample-shortfall")).toBeGreaterThan(30_000);
    expect(activeThreshold(frame, model.thresholds)?.threshold.id).toBe("sample-shortfall");
  });

  it("the sample-gate experiment clears its shortfall with a longer window", () => {
    const sample = module.experiments.find((item) => item.id === "predict-sample-gate");
    if (!sample || !sample.fix) throw new Error("Missing sample-gate experiment");
    const before = runModel(model, sample.setup, 20261110, sample.runFor);
    const after = runModel(model, sample.fix, 20261110, sample.runFor);
    expect(activeThreshold(before, model.thresholds)?.threshold.id).toBe("sample-shortfall");
    expect(activeThreshold(after, model.thresholds)).toBeNull();
    expect(metricValue(after, "sample-shortfall")).toBe(0);
  });

  it("raising dependency capacity and lowering overhead clears the full-rollout failure", () => {
    const failing = runModel(model, params("failure"), 20261110, 30);
    const fixed = runModel(
      model,
      { ...params("failure"), dependencyCapacity: 24_000, versionOverhead: 20 },
      20261110,
      30,
    );
    expect(activeThreshold(failing, model.thresholds)?.severity).toBe("crit");
    expect(activeThreshold(fixed, model.thresholds)).toBeNull();
    expect(metricValue(fixed, "dependency-utilization")).toBeLessThan(85);
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
    expect(model.params.length).toBe(5);
    expect(module.sims["canary-gate"].presets).toHaveLength(6);
    expect(module.experiments).toHaveLength(2);
    expect(module.sims["canary-gate"].experimentIds).toHaveLength(2);
    expect(module.sims["canary-gate"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
