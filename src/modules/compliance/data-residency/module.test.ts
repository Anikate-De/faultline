import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, residencyModel } from "./module";

const model = residencyModel;
const presets = module.sims["residency"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("compliance-data-residency model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "boundary-violations")).toBe(0);
    expect(value(frame, "telemetry-gap")).toBe(0);
    expect(value(frame, "support-gap")).toBe(0);
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
      for (const item of series) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "boundary-violations")).toBeGreaterThanOrEqual(25);
    expect(value(frame, "telemetry-gap")).toBeGreaterThanOrEqual(20);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "boundary-violations")).toBe(0);
    expect(value(frame, "in-region-coverage")).toBe(100);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-boundary-violations-crit");
    const custom = frame.events.filter((event) => event.id === "path-left-region");
    expect(critical.length).toBe(1);
    expect(custom.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("keeps the regional store healthy while the full path crosses the boundary", () => {
    const frame = runModel(model, { ...module.experiments[0].setup }, 20261110, 20);
    expect(value(frame, "in-region-coverage")).toBe(0);
    expect(value(frame, "boundary-violations")).toBe(100);
    expect(frame.nodes.find((node) => node.id === "store")?.health).toBe("ok");
    expect(frame.nodes.find((node) => node.id === "telemetry")?.health).toBe("crit");
    expect(frame.nodes.find((node) => node.id === "support")?.health).toBe("crit");
  });

  it("restores the full path when telemetry and support are regional", () => {
    const frame = runModel(model, { ...module.experiments[0].fix }, 20261110, 20);
    expect(value(frame, "boundary-violations")).toBe(0);
    expect(value(frame, "telemetry-gap")).toBe(0);
    expect(value(frame, "support-gap")).toBe(0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("points the boundary event at the weakest layer", () => {
    const frame = runModel(
      model,
      { storageCoverage: 100, processingCoverage: 70, telemetryCoverage: 100, supportAccessCoverage: 100 },
      20261110,
      20,
    );
    const event = frame.events.find((item) => item.id === "path-left-region");
    expect(event?.nodeId).toBe("app");
    expect(event?.detail).toContain("processing");
  });

  it("treats a store-only design as a warning, not a healthy path", () => {
    const frame = runModel(model, params("store-only"), 20261110, 20);
    expect(value(frame, "boundary-violations")).toBe(15);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
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
      const other = stepped.metrics.find((metricValue) => metricValue.id === item.id);
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
