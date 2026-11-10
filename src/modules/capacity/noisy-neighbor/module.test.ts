import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, noisyNeighborModel } from "./module";

const model = noisyNeighborModel;
const presets = module.sims["noisy-neighbor"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("capacity-noisy-neighbor model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 45);
    const b = runModel(model, params("failure"), 42, 45);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative values", () => {
    const frame = runModel(model, params("failure"), 7, 90);
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

  it("stays healthy with a reservation and fitting batch demand", () => {
    const frame = runModel(model, params("healthy"), 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "interactive-p99")).toBeLessThan(300);
  });

  it("crosses critical within 45 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "interactive-p99")).toBeGreaterThan(800);
    expect(value(frame, "interactive-errors")).toBeGreaterThan(5);
  });

  it("isolates the interactive tenant before the failure threshold", () => {
    const early = runModel(model, params("failure"), 20261110, 8);
    const late = runModel(model, params("failure"), 20261110, 45);
    expect(value(early, "interactive-p99")).toBeLessThan(300);
    expect(activeThreshold(early, model.thresholds)?.severity).not.toBe("crit");
    expect(value(late, "interactive-p99")).toBeGreaterThan(800);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "interactive-p99")).toBeLessThan(300);
  });

  it("a quota contains the batch tenant and leaves interactive capacity", () => {
    const frame = runModel(model, params("quota"), 20261110, 40);
    expect(value(frame, "batch-served")).toBeLessThan(30);
    expect(value(frame, "batch-throttled")).toBeGreaterThan(10);
    expect(value(frame, "interactive-p99")).toBeLessThan(800);
    expect(frame.events.some((event) => event.id === "tenant-throttled")).toBe(true);
  });

  it("keeps the first critical event when threshold events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-interactive-p99-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
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
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
