import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, outlierModel } from "./module";

const model = outlierModel;
const presets = module.sims["outlier-detection"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("mesh-outlier-detection model", () => {
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
      for (const item of values) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "capacity-loss")).toBeGreaterThan(30);
    expect(value(frame, "error-rate")).toBeGreaterThan(8);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "ejected-pct")).toBe(0);
  });

  it("warns without failing in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "ejected-pct")).toBeGreaterThan(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "host-ejected").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "capacity-below-demand").length).toBe(1);
    expect(frame.events.some((event) => event.id === "ejection-cap")).toBe(true);
  });

  it("ejects the bad host without collapsing the pool when detection is conservative", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(value(frame, "ejected-pct")).toBeGreaterThan(5);
    expect(value(frame, "ejected-pct")).toBeLessThan(15);
    expect(value(frame, "capacity-loss")).toBeGreaterThan(5);
    expect(value(frame, "error-rate")).toBeGreaterThan(2);
    expect(value(frame, "error-rate")).toBeLessThan(8);
  });

  it("collapses the pool when a low threshold and a high cap meet an overload", () => {
    const frame = runModel(model, params("over-eject"), 20261110, 40);
    expect(value(frame, "ejected-pct")).toBeGreaterThan(80);
    expect(value(frame, "capacity-loss")).toBeGreaterThan(80);
    expect(value(frame, "error-rate")).toBeGreaterThan(50);
  });

  it("uses the ejection cap to protect capacity", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(value(frame, "ejected-pct")).toBeLessThanOrEqual(60.1);
    expect(value(frame, "active-hosts")).toBeGreaterThanOrEqual(7.9);
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

  it("is healthy in the healthy preset", () => {
    const frame = runModel(model, params("healthy"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(presets.length).toBe(5);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
