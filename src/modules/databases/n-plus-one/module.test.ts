import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, nPlusOneModel } from "./module";

const model = nPlusOneModel;
const presets = module.sims["n-plus-one"].presets;
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

describe("databases-n-plus-one model", () => {
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
    expect(metricValue(frame, "round-trips")).toBe(1_001);
    expect(metricValue(frame, "page-p95")).toBeCloseTo(23_048.02, 1);
    expect(metricValue(frame, "db-time")).toBe(4_004);
    expect(node(frame, "page")?.health).toBe("crit");
    expect(node(frame, "pool")?.health).toBe("crit");
    expect(node(frame, "db")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "round-trips")).toBe(3);
    expect(metricValue(frame, "page-p95")).toBeCloseTo(17, 6);
    expect(node(frame, "page")?.health).toBe("ok");
    expect(node(frame, "pool")?.health).toBe("ok");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-page-latency-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "threshold-query-count-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "n-plus-one-pattern").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "round-trip-queueing").length).toBe(1);
  });

  it("collapses the round trips with a bounded batch", () => {
    const unbatched = runModel(model, params("failure"), 20261110, 20);
    const batched = runModel(model, { ...params("failure"), batchSize: 50 }, 20261110, 20);
    expect(metricValue(unbatched, "round-trips")).toBe(1_001);
    expect(metricValue(batched, "round-trips")).toBe(21);
    expect(metricValue(batched, "page-p95")).toBeCloseTo(89, 6);
    expect(metricValue(batched, "page-p95")).toBeLessThan(metricValue(unbatched, "page-p95"));
    expect(metricValue(batched, "round-trips")).toBeLessThan(40);
  });

  it("scales round trips with page size and queries per item", () => {
    const small = runModel(model, { ...params("peak"), itemCount: 100 }, 20261110, 20);
    const large = runModel(model, { ...params("peak"), itemCount: 500 }, 20261110, 20);
    const nested = runModel(model, { ...params("peak"), itemCount: 200, queriesPerItem: 2 }, 20261110, 20);
    expect(metricValue(small, "round-trips")).toBe(101);
    expect(metricValue(large, "round-trips")).toBe(501);
    expect(metricValue(nested, "round-trips")).toBe(401);
    expect(metricValue(large, "page-p95")).toBeGreaterThan(metricValue(small, "page-p95"));
  });

  it("warns without failing at the production page-size preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(metricValue(frame, "round-trips")).toBe(201);
    expect(metricValue(frame, "page-p95")).toBeCloseTo(534.13, 1);
    expect(node(frame, "page")?.health).toBe("warn");
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
    expect(module.sims["n-plus-one"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
