import { describe, expect, it } from "vitest";
import {
  activeNodeIncident,
  activeThreshold,
  initModel,
  runModel,
  stepModel,
  TICK,
} from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { connectionDrainingModel, module } from "./module";

const model = connectionDrainingModel;
const presets = module.sims["connection-draining"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 20) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("traffic-connection-draining model", () => {
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

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "error-rate")?.value).toBeGreaterThan(5);
    expect(frame.metrics.find((item) => item.id === "cut-requests")?.value).toBeGreaterThan(1_000);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "threshold-error-rate-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "drain-too-short").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "deploy-start").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["error-rate"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("cuts requests only when the delay is shorter than request duration", () => {
    expect(valueOf("healthy", "cut-requests")).toBe(0);
    expect(valueOf("healthy", "error-rate")).toBe(0);
    expect(valueOf("failure", "cut-requests")).toBeGreaterThan(1_000);
    const longDelay = runModel(
      model,
      { ...params("failure"), deregistrationDelay: 20 },
      20261110,
      20,
    );
    expect(longDelay.metrics.find((item) => item.id === "cut-requests")?.value ?? 0).toBe(0);
  });

  it("zero delay cuts every in-flight request on the removed target", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), deregistrationDelay: 0, requestDuration: 5 },
      20261110,
      20,
    );
    const byId = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    expect(byId("drain-completion")).toBe(0);
    expect(byId("error-rate")).toBeCloseTo(100 / 6, 4);
    expect(byId("cut-requests")).toBeCloseTo((20_000 / 6) * 5, 0);
  });

  it("a larger batch removes more capacity and fails more requests", () => {
    const one = runModel(model, params("failure"), 20261110, 20);
    const three = runModel(model, { ...params("failure"), batchSize: 3 }, 20261110, 20);
    const metric = (frame: typeof one, id: string) =>
      frame.metrics.find((item) => item.id === id)?.value ?? 0;
    expect(metric(three, "capacity-loss")).toBeGreaterThan(metric(one, "capacity-loss"));
    expect(metric(three, "error-rate")).toBeGreaterThan(metric(one, "error-rate"));
  });

  it("a very long delay slows the rollout without cutting requests", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), deregistrationDelay: 300 },
      20261110,
      20,
    );
    expect(frame.metrics.find((item) => item.id === "error-rate")?.value ?? 0).toBe(0);
    expect(frame.metrics.find((item) => item.id === "rollout-time")?.value ?? 0).toBeGreaterThan(900);
    expect(activeThreshold(frame, model.thresholds)?.threshold.id).toBe("rollout-time");
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
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(presets.length).toBe(4);
    expect(module.experiments.length).toBe(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
