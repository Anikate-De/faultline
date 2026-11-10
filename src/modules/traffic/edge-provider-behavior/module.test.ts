import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { edgeProviderBehaviorModel, module } from "./module";

const model = edgeProviderBehaviorModel;
const presets = module.sims["edge-provider-behavior"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("traffic-edge-provider-behavior model", () => {
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
    expect(metric(frame, "stale-rate")).toBeCloseTo(50, 0);
    expect(metric(frame, "stale-rate")).toBeLessThanOrEqual(metric(frame, "hit-rate"));
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event and fires the stale deploy event once", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "threshold-stale-rate-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "stale-deploy").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["stale-rate"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("the same intent on the other provider changes purge propagation", () => {
    const cloudflare = runModel(model, params("healthy"), 20261110, 5);
    const akamai = runModel(model, params("ported"), 20261110, 5);
    expect(metric(akamai, "purge-lag")).toBeGreaterThan(metric(cloudflare, "purge-lag"));
    expect(metric(akamai, "hit-rate")).toBeCloseTo(metric(cloudflare, "hit-rate"), 6);
  });

  it("a URL purge misses query variants", () => {
    const tag = runModel(model, { ...params("healthy"), purgeScope: 1 }, 20261110, 5);
    const url = runModel(model, { ...params("healthy"), purgeScope: 0 }, 20261110, 5);
    expect(metric(url, "stale-rate")).toBeGreaterThan(metric(tag, "stale-rate"));
  });

  it("redirect before cache adds stale content", () => {
    const cacheFirst = runModel(model, params("recovery"), 20261110, 5);
    const redirectFirst = runModel(model, { ...params("recovery"), ruleOrder: 1 }, 20261110, 5);
    expect(metric(redirectFirst, "stale-rate")).toBeGreaterThan(metric(cacheFirst, "stale-rate"));
  });

  it("the failure is a configuration difference, not origin capacity", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    expect(metric(frame, "hit-rate")).toBeGreaterThan(49);
    expect(metric(frame, "origin-rps")).toBeGreaterThan(6_000);
    expect(metric(frame, "purge-lag")).toBeLessThan(120);
  });

  it("runs the experiment at the ported setup it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-portability");
    expect(experiment?.setup.provider).toBe(1);
    expect(experiment?.setup.purgeScope).toBe(0);
    expect(experiment?.setup.ruleOrder).toBe(1);
    expect(experiment?.fix?.purgeScope).toBe(1);
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
    expect(module.sims["edge-provider-behavior"].alternateVisuals).toContain("timeline");
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
