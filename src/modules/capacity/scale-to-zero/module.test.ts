import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, scaleToZeroModel } from "./module";

const model = scaleToZeroModel;
const presets = module.sims["scale-to-zero"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("capacity-scale-to-zero model", () => {
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
    for (const series of Object.values(frame.series)) {
      for (const point of series) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("keeps the environment warm with a floor", () => {
    const frame = runModel(model, params("healthy"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "wake-p99")).toBeLessThan(5_000);
    expect(value(frame, "wake-timeouts")).toBe(0);
  });

  it("crosses critical within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "wake-p99")).toBeGreaterThan(30_000);
    expect(value(frame, "wake-timeouts")).toBeGreaterThan(5);
  });

  it("warns when the cold start is slow but under the client timeout", () => {
    const frame = runModel(model, params("peak"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "wake-p99")).toBeGreaterThan(5_000);
    expect(value(frame, "wake-timeouts")).toBe(0);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "wake-p99")).toBeLessThan(5_000);
  });

  it("saves idle cost but adds cold starts when the floor is removed", () => {
    const warm = runModel(model, params("healthy"), 20261110, 30);
    const cold = runModel(model, params("peak"), 20261110, 30);
    expect(value(cold, "monthly-cost")).toBeLessThan(value(warm, "monthly-cost"));
    expect(value(cold, "cold-starts")).toBeGreaterThan(0);
    expect(value(cold, "wake-p99")).toBeGreaterThan(value(warm, "wake-p99"));
  });

  it("a fast image makes scale-to-zero safe under the timeout", () => {
    const frame = runModel(model, { ...params("failure"), coldStartSec: 4 }, 20261110, 30);
    expect(value(frame, "wake-p99")).toBeLessThan(5_000);
    expect(value(frame, "wake-timeouts")).toBe(0);
    expect(value(frame, "monthly-cost")).toBeLessThan(60);
  });

  it("emits the timeout event once and deduplicates threshold events", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "first-request-timeout")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "threshold-wake-p99-crit")).toHaveLength(1);
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
    expect(presets).toHaveLength(4);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
