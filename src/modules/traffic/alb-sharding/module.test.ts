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
import { albShardingModel, module } from "./module";

const model = albShardingModel;
const presets = module.sims["alb-sharding"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 20) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("traffic-alb-sharding model", () => {
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
    expect(frame.metrics.find((item) => item.id === "hot-shard-utilization")?.value).toBeGreaterThan(95);
    expect(frame.metrics.find((item) => item.id === "error-rate")?.value).toBeGreaterThan(2);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "threshold-hot-shard-utilization-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "hot-shard-saturated").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["hot-shard-utilization"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("the hot shard is worse than the fleet average", () => {
    expect(valueOf("failure", "hot-shard-utilization")).toBeGreaterThan(100);
    expect(valueOf("failure", "imbalance")).toBeGreaterThan(2);
    expect(valueOf("failure", "error-rate")).toBeGreaterThan(2);
  });

  it("adding a shard with the same hostname key does not split the hot tenant", () => {
    const base = runModel(model, params("failure"), 20261110, 20);
    const extra = runModel(model, { ...params("failure"), shardCount: 4 }, 20261110, 20);
    const hot = (frame: typeof base) =>
      frame.metrics.find((item) => item.id === "hot-shard-utilization")?.value ?? 0;
    expect(hot(extra)).toBeGreaterThan(95);
    expect(hot(extra)).toBeGreaterThan(hot(base) * 0.5);
  });

  it("path splitting balances the fleet at the cost of affinity", () => {
    const split = runModel(model, params("path-split"), 20261110, 20);
    const byId = (id: string) => split.metrics.find((item) => item.id === id)?.value ?? 0;
    expect(byId("hot-shard-utilization")).toBeLessThan(80);
    expect(byId("error-rate")).toBe(0);
    expect(byId("affinity-loss")).toBeGreaterThan(0);
    const single = runModel(model, { ...params("path-split"), shardCount: 1 }, 20261110, 20);
    expect(single.metrics.find((item) => item.id === "affinity-loss")?.value ?? -1).toBe(0);
  });

  it("reports per-shard CPU series for the heatmap", () => {
    const frame = runModel(model, params("healthy"), 20261110, 5);
    expect(frame.series["cpu.shard-0"]?.length ?? 0).toBeGreaterThan(0);
    expect(frame.series["cpu.shard-1"]?.length ?? 0).toBeGreaterThan(0);
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
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(presets.length).toBe(5);
    expect(module.experiments.length).toBe(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
