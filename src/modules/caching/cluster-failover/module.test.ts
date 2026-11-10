import { describe, expect, it } from "vitest";
import {
  activeNodeIncident,
  activeThreshold,
  applyPresetFrame,
  initModel,
  runModel,
  stepModel,
  TICK,
} from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { clusterFailoverModel, module } from "./module";
import { meta } from "./meta";

const model = clusterFailoverModel;
const presets = module.sims["cluster-failover"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("caching-cluster-failover model", () => {
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
      expect(Number.isFinite(node.throughput ?? 0)).toBe(true);
      expect(node.throughput ?? 0).toBeGreaterThanOrEqual(0);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("loads the healthy preset with no active incident", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    const stepped = applyPresetFrame(model, preset("healthy"), 20261110);
    expect(activeThreshold(stepped, model.thresholds)).toBeNull();
    expect(activeNodeIncident(stepped)).toBeNull();
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "error-rate")).toBeGreaterThan(5);
    expect(metricValue(frame, "stale-clients")).toBeGreaterThan(30);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "primary-unreachable");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("promotes the replica and leaves stale clients behind", () => {
    const early = runModel(model, params("failure"), 20261110, 10);
    const late = runModel(model, params("failure"), 20261110, 60);
    expect(metricValue(early, "redis-p99")).toBeGreaterThan(500);
    expect(metricValue(late, "redis-p99")).toBeLessThan(50);
    expect(metricValue(late, "error-rate")).toBeGreaterThan(5);
    expect(late.events.filter((event) => event.id === "replica-promoted").length).toBe(1);
  });

  it("reports a historical lost-write count for a partition but not for a crash", () => {
    const crash = runModel(model, params("failure"), 20261110, 60);
    const partition = runModel(model, params("partition"), 20261110, 60);
    expect(metricValue(crash, "lost-writes")).toBe(0);
    expect(metricValue(partition, "lost-writes")).toBeGreaterThan(0);
    expect(partition.events.filter((event) => event.id === "partition-writes-lost").length).toBe(1);
    expect(activeThreshold(partition, model.thresholds)).toBeNull();
    expect(activeNodeIncident(partition)).toBeNull();
  });

  it("handles a partition that heals before promotion", () => {
    const frame = runModel(
      model,
      { ...params("failure"), partitionSeconds: 10, nodeTimeout: 15 },
      20261110,
      20,
    );
    expect(metricValue(frame, "lost-writes")).toBe(0);
    expect(frame.summary).toContain("healed before promotion");
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(frame.events.filter((event) => event.id === "replica-promoted").length).toBe(0);
  });

  it("shortens the outage when detection and refresh are fast", () => {
    const slow = runModel(model, params("peak"), 20261110, 60);
    const fast = runModel(model, params("recovery"), 20261110, 60);
    expect(metricValue(fast, "error-rate")).toBe(0);
    expect(metricValue(slow, "error-rate")).toBe(0);
    expect(metricValue(fast, "stale-clients")).toBe(0);
    expect(metricValue(slow, "stale-clients")).toBe(0);
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
      expect(stepped.metrics.find((other) => other.id === item.id)?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(meta.tags).toEqual(["failover", "replica promotion", "topology refresh", "retry", "split brain"]);
    expect(model.params.length).toBe(5);
    expect(presets.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
