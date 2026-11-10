import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, rightsizingModel } from "./module";

const model = rightsizingModel;
const presets = module.sims.rightsizing.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;

describe("capacity-rightsizing model", () => {
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
    for (const values of Object.values(frame.series)) {
      for (const point of values) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "peak-cpu")?.value).toBeGreaterThan(85);
    expect(frame.metrics.find((item) => item.id === "p99-latency")?.value).toBeGreaterThan(800);
    expect(frame.metrics.find((item) => item.id === "memory")?.value).toBeGreaterThan(95);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the healthy preset inside its targets and catches an oversized fleet on cost", () => {
    const healthy = runModel(model, params("healthy"), 20261110, 60);
    const oversized = runModel(model, params("oversized"), 20261110, 60);
    expect(activeThreshold(healthy, model.thresholds)).toBeNull();
    expect(activeThreshold(oversized, model.thresholds)?.severity).toBe("crit");
    expect(oversized.metrics.find((item) => item.id === "cost-per-mreq")?.value ?? 0).toBeGreaterThan(0.35);
    expect(oversized.metrics.find((item) => item.id === "p99-latency")?.value ?? 0).toBeLessThan(300);
  });

  it("shows average CPU below peak CPU and hides the burst at first", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const average = frame.metrics.find((item) => item.id === "average-cpu")?.value ?? 0;
    const peak = frame.metrics.find((item) => item.id === "peak-cpu")?.value ?? 0;
    expect(average).toBeLessThan(50);
    expect(peak).toBeGreaterThan(150);
    expect(peak).toBeGreaterThan(average * 3);
  });

  it("keeps the first peak event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const events = frame.events.filter((event) => event.id === "daily-peak");
    expect(events.length).toBe(1);
  });

  it("restoring 4 vCPU at the same peak clears the critical thresholds", () => {
    const down = runModel(model, params("failure"), 20261110, 45);
    const restored = runModel(model, { ...params("failure"), instanceVcpu: 4, fleetCount: 40 }, 20261110, 45);
    expect(activeThreshold(down, model.thresholds)?.severity).toBe("crit");
    expect(activeThreshold(restored, model.thresholds)).toBeNull();
    expect(restored.metrics.find((item) => item.id === "peak-cpu")?.value ?? 0).toBeLessThan(70);
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
      const other = stepped.metrics.find((entry) => entry.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(4);
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
