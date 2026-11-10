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
import { module, mongosRoutingModel } from "./module";

const model = mongosRoutingModel;
const presets = module.sims["mongos-routing"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const node = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.nodes.find((item) => item.id === id);

describe("mongodb-mongos-routing model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps the healthy preset calm at t=0", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(frame.nodes.filter((item) => item.health !== "ok")).toEqual([]);
  });

  it("never reports NaN, Infinity, or out-of-range utilization", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const item of frame.nodes) {
      expect(Number.isFinite(item.utilization ?? 0)).toBe(true);
      expect(item.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(item.utilization ?? 0).toBeLessThanOrEqual(1);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 5);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "mongos-p99")).toBeGreaterThan(120);
    expect(metricValue(frame, "shards-touched")).toBe(4);
    expect(node(frame, "mongos")?.health).toBe("crit");
  });

  it("keeps the router, not the shards, as the bottleneck in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(metricValue(frame, "merge-share")).toBeGreaterThan(50);
    expect(metricValue(frame, "shard-cpu")).toBeLessThan(75);
    expect(node(frame, "shard-0")?.health).toBe("ok");
    expect(node(frame, "config")?.health).toBe("ok");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "shards-touched")).toBe(1);
    expect(metricValue(frame, "mongos-p99")).toBeLessThan(50);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-merge-share-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "merge-dominant")).toHaveLength(1);
  });

  it("targeting the shard key and narrowing rows removes the router bottleneck", () => {
    const wide = runModel(model, params("failure"), 20261110, 20);
    const targeted = runModel(
      model,
      { ...params("failure"), targetedShare: 100, resultRows: 50 },
      20261110,
      20,
    );
    expect(metricValue(wide, "shards-touched")).toBe(4);
    expect(metricValue(targeted, "shards-touched")).toBe(1);
    expect(metricValue(targeted, "mongos-p99")).toBeLessThan(metricValue(wide, "mongos-p99"));
    expect(activeThreshold(targeted, model.thresholds)).toBeNull();
  });

  it("preserves existing frame flags across a step", () => {
    const frame = initModel(model, params("healthy"), 7);
    frame.flags.marker = 1;
    const next = stepModel(model, frame, params("healthy"), createRng(7));
    expect(next.flags.marker).toBe(1);
    expect(next.flags.seed).toBe(7);
  });

  it("recovers with the experiment fix", () => {
    const experiment = module.experiments[0];
    const broken = runModel(model, experiment.setup, 20261110, experiment.runFor);
    expect(activeThreshold(broken, model.thresholds)?.severity).toBe("crit");
    const fixed = runModel(model, experiment.fix ?? params("recovery"), 20261110, experiment.runFor);
    expect(activeThreshold(fixed, model.thresholds)).toBeNull();
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
    expect(model.params.length).toBe(4);
    expect(presets).toHaveLength(5);
    expect(presets.map((item) => item.id)).toEqual([
      "healthy",
      "peak",
      "failure",
      "recovery",
      "wide",
    ]);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
