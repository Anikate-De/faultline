import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { leakModel, module } from "./module";

const model = leakModel;
const presets = module.sims["connection-leak"].presets;
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

describe("databases-connection-leak model", () => {
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
      expect(item.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(item.utilization ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "pool-utilization")).toBe(100);
    expect(metricValue(frame, "leaked-connections")).toBeGreaterThan(1_000);
    expect(metricValue(frame, "checkout-errors")).toBeGreaterThan(30);
    expect(node(frame, "pool")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "pool-utilization")).toBeLessThan(20);
    expect(metricValue(frame, "leaked-connections")).toBe(0);
  });

  it("keeps a slow leak in warning at 20 seconds", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(metricValue(frame, "pool-utilization")).toBeGreaterThan(75);
    expect(metricValue(frame, "pool-utilization")).toBeLessThan(90);
  });

  it("grows the leak without changing request rate", () => {
    const early = runModel(model, params("failure"), 20261110, 5);
    const later = runModel(model, params("failure"), 20261110, 25);
    expect(metricValue(later, "leaked-connections")).toBeGreaterThan(metricValue(early, "leaked-connections"));
    expect(metricValue(later, "leaked-connections")).toBeCloseTo(metricValue(early, "leaked-connections") + 800, 0);
  });

  it("clears the leak when the close path is fixed", () => {
    const leaking = runModel(model, params("failure"), 20261110, 30);
    const fixed = runModel(model, { ...params("failure"), leakOnErrorPct: 0 }, 20261110, 30);
    expect(metricValue(leaking, "pool-utilization")).toBe(100);
    expect(metricValue(fixed, "pool-utilization")).toBeLessThan(20);
  });

  it("keeps one critical event for a sustained leak", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "pool-exhausted").length).toBe(1);
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
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
