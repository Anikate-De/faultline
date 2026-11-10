import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, naclsModel } from "./module";

const model = naclsModel;
const presets = module.sims["acl-path"].presets;
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

describe("cloud-networking-nacls model", () => {
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

  it("loads healthy at t=0 with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "delivery-rate")).toBe(100);
    expect(metricValue(frame, "blocked-requests")).toBe(0);
    expect(metricValue(frame, "return-drops")).toBe(0);
  });

  it("crosses critical within 30 simulated seconds when the client return rule is missing", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "delivery-rate")).toBe(0);
    expect(metricValue(frame, "blocked-requests")).toBeGreaterThan(100);
    expect(metricValue(frame, "return-drops")).toBe(800);
    expect(node(frame, "web-acl")?.health).toBe("crit");
    expect(node(frame, "app-acl")?.health).toBe("ok");
    expect(frame.events.some((event) => event.id === "client-return-removed")).toBe(true);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "delivery-rate")).toBe(100);
    expect(metricValue(frame, "blocked-requests")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "client-return-removed")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "threshold-return-drops-crit")).toHaveLength(1);
  });

  it("separates a missing app return rule from a missing client return rule", () => {
    const appReturn = runModel(model, params("app-return"), 20261110, 20);
    const clientReturn = runModel(model, params("failure"), 20261110, 20);
    expect(node(appReturn, "app-acl")?.health).toBe("crit");
    expect(node(appReturn, "web-acl")?.health).toBe("warn");
    expect(node(appReturn, "service")?.health).toBe("crit");
    expect(node(clientReturn, "web-acl")?.health).toBe("crit");
    expect(node(clientReturn, "app-acl")?.health).toBe("ok");
    expect(metricValue(clientReturn, "return-drops")).toBe(800);
  });

  it("keeps delivery complete at peak without introducing a threshold", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(metricValue(frame, "delivery-rate")).toBe(100);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
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
