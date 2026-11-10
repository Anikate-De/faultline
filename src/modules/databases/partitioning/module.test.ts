import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, partitioningModel } from "./module";

const model = partitioningModel;
const presets = module.sims.partitioning.presets;
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

describe("databases-partitioning model", () => {
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

  it("crosses critical thresholds within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "query-p95")).toBeCloseTo(11_378.37, 1);
    expect(metricValue(frame, "hot-cpu")).toBe(100);
    expect(metricValue(frame, "maintenance-min")).toBeCloseTo(174, 6);
    expect(frame.nodes).toHaveLength(1);
    expect(node(frame, "shard-1")?.health).toBe("crit");
    expect(node(frame, "shard-1")?.meta?.hot).toBe(1);
    expect(frame.summary).toContain("single table");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "query-p95")).toBeCloseTo(129.12, 6);
    expect(metricValue(frame, "hot-cpu")).toBeCloseTo(49.5, 6);
    expect(metricValue(frame, "maintenance-min")).toBeCloseTo(3.6, 6);
    expect(frame.nodes).toHaveLength(8);
    expect(node(frame, "shard-1")?.health).toBe("ok");
    expect(node(frame, "shard-8")?.health).toBe("ok");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-query-latency-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "threshold-hot-shard-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "threshold-maintenance-window-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "hot-shard").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "maintenance-window").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "single-writer").length).toBe(1);
  });

  it("shortens maintenance with partitioning but leaves one hot writer", () => {
    const single = runModel(model, params("failure"), 20261110, 20);
    const partitioned = runModel(model, { ...params("failure"), partitionCount: 24 }, 20261110, 20);
    expect(metricValue(partitioned, "maintenance-min")).toBeCloseTo(10.4, 6);
    expect(metricValue(partitioned, "maintenance-min")).toBeLessThan(
      metricValue(single, "maintenance-min"),
    );
    expect(metricValue(partitioned, "hot-cpu")).toBe(100);
    expect(partitioned.nodes).toHaveLength(1);
    expect(metricValue(partitioned, "query-p95")).toBeCloseTo(3_983.97, 1);
  });

  it("does not fix skew by adding shards without spreading the hot slice", () => {
    const sharded = runModel(model, { ...params("failure"), shardCount: 8 }, 20261110, 20);
    expect(metricValue(sharded, "hot-cpu")).toBe(100);
    expect(metricValue(sharded, "query-p95")).toBeGreaterThan(900);
    expect(node(sharded, "shard-1")?.health).toBe("crit");
    expect(sharded.nodes).toHaveLength(8);
  });

  it("spreads the hot slice and recovers with a larger archive", () => {
    const skewed = runModel(model, { ...params("failure"), shardCount: 8 }, 20261110, 20);
    const spread = runModel(
      model,
      { ...params("failure"), tableRows: 400, shardCount: 8, hotShare: 15, archivePercent: 70 },
      20261110,
      20,
    );
    expect(metricValue(spread, "hot-cpu")).toBeLessThan(metricValue(skewed, "hot-cpu"));
    expect(metricValue(spread, "query-p95")).toBeLessThan(900);
    expect(activeThreshold(spread, model.thresholds)).toBeNull();
  });

  it("renders one card per shard", () => {
    const frame = runModel(model, { ...params("healthy"), shardCount: 8 }, 20261110, 20);
    expect(frame.nodes).toHaveLength(8);
    expect(Object.keys(frame.series).some((key) => key.startsWith("cpu.shard-"))).toBe(true);
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
    expect(model.params.length).toBeGreaterThanOrEqual(3);
    expect(model.params.length).toBeLessThanOrEqual(6);
    expect(module.sims.partitioning.presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
