import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { hotShardModel, module } from "./module";

const model = hotShardModel;
const presets = module.sims["hot-shard"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const shards = (frame: ReturnType<typeof runModel>) => frame.nodes.filter((item) => item.role === "shard");

describe("mongodb-hot-shard model", () => {
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
    expect(metricValue(frame, "hot-shard-cpu")).toBeGreaterThan(90);
    expect(shards(frame).filter((item) => item.health === "crit")).toHaveLength(1);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "hot-shard-cpu")).toBeLessThan(50);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-hot-shard-cpu-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("shows a saturated shard while chunk counts are nearly balanced", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(metricValue(frame, "chunk-skew")).toBeLessThan(1.35);
    expect(metricValue(frame, "hot-shard-cpu")).toBeGreaterThan(90);
    expect(metricValue(frame, "query-p99")).toBeGreaterThan(150);
    expect(metricValue(frame, "avg-shard-cpu")).toBeLessThan(70);
  });

  it("keeps a monotonic key concentrated even with an active balancer", () => {
    const frame = runModel(model, params("monotonic"), 20261110, 30);
    expect(metricValue(frame, "chunk-skew")).toBeLessThan(1.25);
    expect(metricValue(frame, "hot-shard-cpu")).toBeGreaterThan(90);
    expect(metricValue(frame, "chunks-on-hot-shard")).toBeLessThan(70);
  });

  it("spreads writes when the hot key is removed", () => {
    const hot = runModel(model, params("failure"), 20261110, 10);
    const spread = runModel(model, { ...params("failure"), hotKeyShare: 0, keyPattern: 0 }, 20261110, 10);
    expect(metricValue(hot, "write-imbalance")).toBeGreaterThan(2);
    expect(metricValue(spread, "write-imbalance")).toBeCloseTo(1, 1);
    expect(metricValue(spread, "hot-shard-cpu")).toBeLessThan(70);
  });

  it("does not mark ordinary shards saturated during one hotspot", () => {
    const frame = runModel(model, params("failure"), 20261110, 5);
    const nonOk = shards(frame).filter((item) => item.health !== "ok");
    expect(nonOk).toHaveLength(1);
    expect(nonOk[0]?.id).toBe("shard-0");
  });

  it("has reachable critical thresholds at the model limits", () => {
    const frame = runModel(
      model,
      { ...params("failure"), hotKeyShare: 60, keyPattern: 1, balancerRate: 0 },
      20261110,
      1,
    );
    expect(metricValue(frame, "write-imbalance")).toBeGreaterThanOrEqual(3.5);
    expect(metricValue(frame, "chunk-skew")).toBeGreaterThanOrEqual(1.38);
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
    expect(presets.map((item) => item.id)).toEqual(["healthy", "peak", "failure", "monotonic", "recovery"]);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
