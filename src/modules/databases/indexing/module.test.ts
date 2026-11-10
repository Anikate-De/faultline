import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { indexingModel, module } from "./module";

const model = indexingModel;
const presets = module.sims.indexing.presets;
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

describe("databases-indexing model", () => {
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
    expect(metricValue(frame, "read-p95")).toBeCloseTo(1_040, 6);
    expect(metricValue(frame, "write-p95")).toBeCloseTo(6.7, 6);
    expect(metricValue(frame, "rows-read")).toBe(10_000_000);
    expect(node(frame, "table")?.health).toBe("crit");
    expect(node(frame, "index")?.health).toBe("warn");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "read-p95")).toBeCloseTo(21.5, 6);
    expect(metricValue(frame, "write-p95")).toBeCloseTo(2.2, 6);
    expect(node(frame, "table")?.health).toBe("ok");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-read-latency-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "threshold-write-latency-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "index-unusable").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "write-amplification").length).toBe(1);
  });

  it("uses the index when the predicate is sargable and the column leads", () => {
    const sargable = runModel(
      model,
      { ...params("peak"), selectivity: 1, indexCount: 2, writeRate: 800 },
      20261110,
      20,
    );
    expect(metricValue(sargable, "read-p95")).toBeCloseTo(41.5, 6);
    expect(metricValue(sargable, "rows-read")).toBeCloseTo(110_000, 6);
    expect(node(sargable, "index")?.health).toBe("ok");
  });

  it("does not use the index when the predicate column does not lead", () => {
    const frame = runModel(model, { ...params("healthy"), leading: 0 }, 20261110, 20);
    expect(metricValue(frame, "read-p95")).toBeCloseTo(944, 6);
    expect(metricValue(frame, "rows-read")).toBe(10_000_000);
    expect(node(frame, "index")?.health).toBe("warn");
  });

  it("raises write cost with each additional index", () => {
    const two = runModel(model, { ...params("peak"), indexCount: 2 }, 20261110, 20);
    const eight = runModel(model, { ...params("peak"), indexCount: 8 }, 20261110, 20);
    expect(metricValue(eight, "write-p95")).toBeGreaterThan(metricValue(two, "write-p95"));
    expect(metricValue(eight, "write-p95") - metricValue(two, "write-p95")).toBeCloseTo(2.7, 6);
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
    expect(module.sims.indexing.presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
