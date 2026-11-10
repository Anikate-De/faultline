import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, routeTableModel } from "./module";

const model = routeTableModel;
const presets = module.sims["route-path"].presets;
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

describe("cloud-networking-route-tables model", () => {
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

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "delivery-rate")).toBe(0);
    expect(node(frame, "route")?.health).toBe("crit");
    expect(node(frame, "target")?.health).toBe("down");
    expect(node(frame, "route")?.meta?.routeState).toBe("blackhole");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "delivery-rate")).toBe(100);
    expect(metricValue(frame, "dropped-pps")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-failure-rate-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "route-blackhole").length).toBe(1);
  });

  it("separates a blackhole from a missing return route", () => {
    const blackhole = runModel(model, params("failure"), 20261110, 20);
    const returnPath = runModel(model, params("return-path"), 20261110, 20);
    expect(metricValue(blackhole, "forwarded-pps")).toBe(0);
    expect(metricValue(returnPath, "forwarded-pps")).toBeGreaterThan(0);
    expect(metricValue(returnPath, "delivery-rate")).toBe(0);
    expect(node(returnPath, "peer")?.health).toBe("crit");
    expect(node(returnPath, "target")?.health).not.toBe("down");
  });

  it("treats target saturation as a drop even when the route is active", () => {
    const saturated = runModel(
      model,
      { ...params("healthy"), packetRate: 9_000, targetCapacity: 5_000 },
      20261110,
      20,
    );
    expect(metricValue(saturated, "target-utilization")).toBeGreaterThanOrEqual(95);
    expect(metricValue(saturated, "delivery-rate")).toBeLessThan(95);
    expect(metricValue(saturated, "dropped-pps")).toBeGreaterThan(0);
  });

  it("keeps delivery complete at peak when the target has headroom", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(metricValue(frame, "delivery-rate")).toBe(100);
    expect(metricValue(frame, "target-utilization")).toBeGreaterThanOrEqual(80);
    expect(metricValue(frame, "target-utilization")).toBeLessThan(95);
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
    expect(module.sims["route-path"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
