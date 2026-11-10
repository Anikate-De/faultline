import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, seasonalForecastModel } from "./module";

const model = seasonalForecastModel;
const presets = module.sims["seasonal-forecast"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("capacity-seasonal-forecast model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 60);
    const b = runModel(model, params("failure"), 42, 60);
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
    for (const series of Object.values(frame.series)) {
      for (const point of series) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("keeps the seasonal peak inside the plan when the forecast includes it", () => {
    const frame = runModel(model, params("healthy"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "peak-utilization")).toBeLessThan(85);
  });

  it("crosses critical during the seasonal ramp in the failure preset", () => {
    const early = runModel(model, params("failure"), 20261110, 10);
    const late = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(early, model.thresholds)?.severity).not.toBe("crit");
    expect(activeThreshold(late, model.thresholds)?.severity).toBe("crit");
    expect(value(late, "peak-utilization")).toBeGreaterThan(100);
    expect(value(late, "unplanned-peak")).toBeGreaterThan(15);
  });

  it("serves the peak but leaves no buffer at the point estimate", () => {
    const frame = runModel(model, params("peak"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "peak-utilization")).toBeGreaterThan(85);
    expect(value(frame, "unplanned-peak")).toBe(0);
  });

  it("shows that a wide band does not fix a linear forecast", () => {
    const frame = runModel(model, params("hedged-linear"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "peak-utilization")).toBeGreaterThan(85);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "peak-utilization")).toBeLessThan(85);
  });

  it("buys more capacity at a higher planning percentile", () => {
    const point = runModel(model, { ...params("healthy"), planningPercentile: 50 }, 20261110, 30);
    const wide = runModel(model, { ...params("healthy"), planningPercentile: 99 }, 20261110, 30);
    expect(value(wide, "planned-capacity")).toBeGreaterThan(value(point, "planned-capacity"));
    expect(value(wide, "monthly-cost")).toBeGreaterThan(value(point, "monthly-cost"));
  });

  it("emits the seasonal ramp event once and deduplicates threshold events", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "seasonal-ramp")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "threshold-peak-utilization-crit")).toHaveLength(1);
  });

  it("runFor matches stepping the same number of ticks", () => {
    const seconds = 30;
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
    expect(model.params.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
