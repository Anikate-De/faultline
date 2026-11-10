import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, egressCostModel } from "./module";

const model = egressCostModel;
const presets = module.sims["cost-path"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("cloud-networking-egress-cost model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps every metric and series value finite and non-negative", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const series of Object.values(frame.series)) {
      for (const point of series) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses critical within 30 simulated seconds on cross-region chatter", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "monthly-cost")).toBeGreaterThan(10_000);
    expect(value(frame, "region-share")).toBeGreaterThan(50);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "monthly-cost")).toBeLessThan(5_000);
    expect(value(frame, "nat-tb")).toBe(0);
  });

  it("raises cost through NAT processing without cross-region traffic", () => {
    const frame = runModel(model, params("nat-heavy"), 20261110, 30);
    expect(value(frame, "region-share")).toBeLessThan(10);
    expect(value(frame, "monthly-cost")).toBeGreaterThan(10_000);
    expect(value(frame, "nat-tb")).toBeGreaterThan(200);
  });

  it("keeps peak below critical", () => {
    const frame = runModel(model, params("peak"), 20261110, 30);
    expect(value(frame, "monthly-cost")).toBeGreaterThanOrEqual(5_000);
    expect(value(frame, "monthly-cost")).toBeLessThan(10_000);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("deduplicates the egress-cost event", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-monthly-cost-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "egress-cost").length).toBe(1);
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
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
  });
});
