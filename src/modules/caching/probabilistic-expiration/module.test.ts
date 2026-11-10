import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, probabilisticExpirationModel as model } from "./module";

const presets = module.sims["probabilistic-expiration"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const maxMetric = (id: string, metricId: string, seconds = 30) => {
  let frame = initModel(model, params(id), 20261110);
  const rng = createRng(20261110);
  let max = 0;
  for (let index = 0; index < seconds / TICK; index++) {
    frame = stepModel(model, frame, params(id), rng);
    max = Math.max(max, metric(frame, metricId));
  }
  return max;
};

describe("caching-probabilistic-expiration model", () => {
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

  it("loads healthy at t=0 with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
  });

  it("keeps the failure preset healthy before the expiry edge", () => {
    const frame = runModel(model, params("failure"), 20261110, 1);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
  });

  it("crosses the critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(maxMetric("failure", "backend-qps", 30)).toBeGreaterThan(9_000);
    expect(frame.events.some((event) => event.id === "threshold-backend-qps-crit")).toBe(true);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("early refresh lowers the peak while total work stays in the same cycle", () => {
    const failure = maxMetric("failure", "backend-qps", 30);
    const recovery = maxMetric("recovery", "backend-qps", 30);
    expect(recovery).toBeLessThan(failure / 10);
    expect(
      metric(runModel(model, params("failure"), 20261110, 15), "hard-expiry-share"),
    ).toBeCloseTo(100, 5);
  });

  it("beta trades extra recomputation for a lower hard-expiry share", () => {
    const noEarly = runModel(model, params("failure"), 20261110, 15);
    const early = runModel(model, params("recovery"), 20261110, 15);
    expect(metric(early, "hard-expiry-share")).toBeLessThan(metric(noEarly, "hard-expiry-share"));
    expect(metric(early, "extra-compute")).toBeGreaterThan(metric(noEarly, "extra-compute"));
  });

  it("fires the synchronized-refresh event once while the wave remains aligned", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    const events = frame.events.filter((event) => event.id === "synchronized-refresh");
    expect(events.length).toBe(1);
    expect(events[0].severity).toBe("crit");
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
    expect(presets.length).toBe(5);
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
