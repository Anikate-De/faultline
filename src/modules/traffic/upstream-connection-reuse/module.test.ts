import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, upstreamReuseModel } from "./module";

const model = upstreamReuseModel;
const presets = module.sims["upstream-reuse"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("traffic-upstream-connection-reuse model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold and no failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
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

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "deploy-share")).toBeGreaterThan(60);
    expect(metricValue(frame, "failed-requests")).toBeGreaterThanOrEqual(0.5);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 40);
    const critical = frame.events.filter((event) => event.id === "threshold-new-connections-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "deploy-connection-storm").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "drain-disabled").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["new-connections"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("warmup removes the deploy connection burst without changing traffic", () => {
    const cold = params("failure");
    const warm = { ...cold, poolWarmup: 1 };
    const before = runModel(model, cold, 3, 20);
    const after = runModel(model, warm, 3, 20);
    expect(metricValue(after, "new-connections")).toBeLessThan(metricValue(before, "new-connections"));
    expect(metricValue(after, "deploy-share")).toBeLessThan(30);
    expect(metricValue(after, "steady-connections")).toBe(metricValue(before, "steady-connections"));
  });

  it("draining addresses failures rather than the connection burst", () => {
    const coldNoDrain = { ...params("failure"), poolWarmup: 0, drainEnabled: 0 };
    const coldDrain = { ...coldNoDrain, drainEnabled: 1 };
    const before = runModel(model, coldNoDrain, 3, 20);
    const after = runModel(model, coldDrain, 3, 20);
    expect(metricValue(before, "failed-requests")).toBeGreaterThan(0);
    expect(metricValue(after, "failed-requests")).toBe(0);
    expect(metricValue(after, "new-connections")).toBeCloseTo(metricValue(before, "new-connections"), 6);
  });

  it("a larger rollout creates more deploy connections at the same pool size", () => {
    const small = runModel(model, { ...params("healthy"), rolloutShare: 10 }, 4, 20);
    const large = runModel(model, { ...params("healthy"), rolloutShare: 80 }, 4, 20);
    expect(metricValue(large, "deploy-connections")).toBeGreaterThan(
      metricValue(small, "deploy-connections"),
    );
    expect(metricValue(large, "pool-connections")).toBeGreaterThan(
      metricValue(small, "pool-connections"),
    );
  });

  it("runs the experiment with warmup off as it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-warmup-storm");
    expect(experiment?.setup.poolWarmup).toBe(0);
    expect(experiment?.setup.rolloutShare).toBe(50);
    expect(experiment?.fix?.poolWarmup).toBe(1);
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
    expect(model.params.length).toBeGreaterThanOrEqual(3);
    expect(model.params.length).toBeLessThanOrEqual(6);
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
