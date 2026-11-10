import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { objectStorageLatencyModel, module } from "./module";

const model = objectStorageLatencyModel;
const presets = module.sims["object-storage-latency"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (id: string, metricId: string, seconds = 20) => {
  const frame = runModel(model, params(id), 20261110, seconds);
  return frame.metrics.find((item) => item.id === metricId)?.value ?? 0;
};

describe("streaming-object-storage-latency model", () => {
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

  it("reaches critical within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue("failure", "read-p99", 30)).toBeGreaterThan(300);
    expect(metricValue("failure", "origin-reads", 30)).toBeGreaterThan(2_500);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps one critical p99 event", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "read-p99-breach").length).toBe(1);
  });

  it("reports aggregate throughput that stays high while the tail fails", () => {
    expect(metricValue("failure", "aggregate-throughput")).toBeGreaterThan(10_000);
    expect(metricValue("failure", "read-p99")).toBeGreaterThan(300);
  });

  it("a warmer cache lowers the tail without changing durability", () => {
    const base = params("peak");
    const cold = runModel(model, { ...base, cacheHitRate: 10 }, 20261110, 10);
    const warm = runModel(model, { ...base, cacheHitRate: 90 }, 20261110, 10);
    const p99 = (frame: typeof cold) => frame.metrics.find((item) => item.id === "read-p99")?.value ?? 0;
    expect(p99(warm)).toBeLessThan(p99(cold));
  });

  it("more concurrency lowers queueing at the same workload", () => {
    const base = { ...params("peak"), readRate: 3_000 };
    const low = runModel(model, { ...base, concurrency: 32 }, 20261110, 10);
    const high = runModel(model, { ...base, concurrency: 256 }, 20261110, 10);
    const p99 = (frame: typeof low) => frame.metrics.find((item) => item.id === "read-p99")?.value ?? 0;
    expect(p99(high)).toBeLessThan(p99(low));
  });

  it("builds an eight-bucket latency histogram", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    expect(frame.histogram?.buckets.length).toBe(8);
    const total = frame.histogram?.buckets.reduce((sum, bucket) => sum + bucket.count, 0) ?? 0;
    expect(total).toBeGreaterThan(900);
    expect(total).toBeLessThan(1_100);
  });

  it("healthy preset has no active threshold", () => {
    const frame = runModel(model, params("healthy"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
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
      const other = stepped.metrics.find((metricItem) => metricItem.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(4);
    expect(presets.length).toBe(4);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(model.visual).toBe("histogram");
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
