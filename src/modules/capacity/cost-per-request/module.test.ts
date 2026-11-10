import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { costPerRequestModel, module } from "./module";

const model = costPerRequestModel;
const presets = module.sims["cost-per-request"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (id: string, seconds: number, presetId = "failure") =>
  runModel(model, params(presetId), 20261110, seconds).metrics.find((item) => item.id === id)?.value ?? 0;

describe("capacity-cost-per-request model", () => {
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
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("is healthy at t=0 and stays healthy through the healthy preset", () => {
    expect(activeThreshold(initModel(model, params("healthy"), 20261110), model.thresholds)).toBeNull();
    expect(activeNodeIncident(initModel(model, params("healthy"), 20261110))).toBeNull();
    expect(activeThreshold(runModel(model, params("healthy"), 20261110, 45), model.thresholds)).toBeNull();
  });

  it("crosses critical with flat traffic within 45 simulated seconds", () => {
    const frame = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "traffic")?.value).toBe(100);
    expect(frame.metrics.find((item) => item.id === "cost-per-million")?.value).toBeGreaterThan(45);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("raises unit cost at fixed traffic only because the mix moves", () => {
    const early = runModel(model, params("failure"), 20261110, 2);
    const late = runModel(model, params("failure"), 20261110, 40);
    const unit = (frame: typeof early) => frame.metrics.find((item) => item.id === "cost-per-million")?.value ?? 0;
    const traffic = (frame: typeof early) => frame.metrics.find((item) => item.id === "traffic")?.value ?? 0;
    expect(traffic(early)).toBe(traffic(late));
    expect(unit(late)).toBeGreaterThan(unit(early));
  });

  it("emits the mix-shift event once", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "mix-shift")).toHaveLength(1);
  });

  it("a stable mix keeps unit cost below the warning line", () => {
    const frame = runModel(model, { ...params("failure"), expensiveSharePct: 20 }, 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue("cost-per-million", 45, "healthy")).toBeLessThan(35);
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
    expect(presets.length).toBe(4);
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
