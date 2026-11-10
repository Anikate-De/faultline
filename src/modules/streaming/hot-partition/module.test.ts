import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { hotPartitionModel, module } from "./module";

const model = hotPartitionModel;
const presets = module.sims["hot-partition"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (id: string, seconds = 20, presetId = "failure") =>
  runModel(model, params(presetId), 20261110, seconds).metrics.find((item) => item.id === id)?.value ?? 0;

describe("streaming-hot-partition model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative utilization", () => {
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

  it("crosses the critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "hot-partition-load")?.value).toBeGreaterThan(85);
    expect(frame.metrics.find((item) => item.id === "hot-partition-lag")?.value).toBeGreaterThan(50_000);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-hot-partition-load-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("does not repeat the hot-key event on every tick", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "hot-key-detected").length).toBe(1);
  });

  it("concentrates lag on the hot partition when the key is unsalted", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const hotLag = frame.metrics.find((item) => item.id === "hot-partition-lag")?.value ?? 0;
    const totalLag = frame.metrics.find((item) => item.id === "queueDepth")?.value ?? 0;
    expect(hotLag).toBeGreaterThan(0);
    expect(hotLag).toBeCloseTo(totalLag, 0);
  });

  it("salting removes skew but can still saturate without enough partition headroom", () => {
    const failure = runModel(model, params("failure"), 20261110, 20);
    const salted = runModel(model, params("salting"), 20261110, 20);
    const load = (frame: typeof failure) => frame.metrics.find((item) => item.id === "hot-partition-load")?.value ?? 0;
    const skew = (frame: typeof failure) => frame.metrics.find((item) => item.id === "partition-skew")?.value ?? 0;
    expect(load(salted)).toBeLessThan(load(failure));
    expect(skew(salted)).toBeLessThan(2);
    expect(load(salted)).toBeGreaterThan(85);
  });

  it("adding partitions alone does not fix the hot key", () => {
    expect(metricValue("hot-partition-load", 20, "repartition")).toBeGreaterThan(300);
  });

  it("a salted key with enough partition and consumer headroom recovers", () => {
    expect(metricValue("hot-partition-load", 20, "recovery")).toBeLessThan(70);
    expect(metricValue("hot-partition-lag", 20, "recovery")).toBe(0);
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
    for (const metric of fast.metrics) {
      const other = stepped.metrics.find((item) => item.id === metric.id);
      expect(other?.value).toBeCloseTo(metric.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(5);
    expect(presets.length).toBe(6);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "salting", "repartition"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
