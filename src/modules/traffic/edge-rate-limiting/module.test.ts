import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { edgeRateLimitingModel, module } from "./module";

const model = edgeRateLimitingModel;
const presets = module.sims["edge-rate-limiting"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("traffic-edge-rate-limiting model", () => {
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

  it("loads the healthy preset with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metric(frame, "nat-blocked")).toBeGreaterThan(5);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event and fires the NAT event once", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "threshold-nat-blocked-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "nat-blocked").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "top-key-limited").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["nat-blocked"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("a per-key limit trims the top key without blocking NAT users", () => {
    const keyOnly = runModel(model, params("key-only"), 20261110, 10);
    expect(metric(keyOnly, "nat-blocked")).toBe(0);
    expect(metric(keyOnly, "throttled")).toBeGreaterThan(30);
    expect(metric(keyOnly, "origin-load")).toBe(18_000);
  });

  it("raising the per-IP limit clears the NAT false positives", () => {
    const failure = runModel(model, params("failure"), 20261110, 10);
    const fixed = runModel(model, { ...params("failure"), perIpLimit: 1_000 }, 20261110, 10);
    expect(metric(failure, "nat-blocked")).toBeGreaterThan(5);
    expect(metric(fixed, "nat-blocked")).toBe(0);
    expect(metric(fixed, "throttled")).toBeLessThan(metric(failure, "throttled"));
  });

  it("the global backstop caps origin load but does not isolate a tenant", () => {
    const peak = runModel(model, params("peak"), 20261110, 10);
    expect(metric(peak, "origin-load")).toBe(22_000);
    expect(metric(peak, "throttled")).toBeGreaterThan(20);
  });

  it("runs the experiment at the NAT setup it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-nat-collateral");
    expect(experiment?.setup.perIpLimit).toBe(100);
    expect(experiment?.fix?.perIpLimit).toBe(1_000);
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
    expect(model.params.length).toBe(5);
    expect(module.sims["edge-rate-limiting"].alternateVisuals).toContain("timeline");
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.experiments.length).toBe(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
