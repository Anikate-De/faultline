import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { gdprModel, module } from "./module";

const model = gdprModel;
const presets = module.sims["gdpr"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("compliance-gdpr model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "rights-gap")).toBe(0);
    expect(value(frame, "residual-copies")).toBe(0);
    expect(value(frame, "lawful-gap")).toBe(0);
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
    expect(value(frame, "rights-gap")).toBeGreaterThanOrEqual(40);
    expect(value(frame, "residual-copies")).toBeGreaterThanOrEqual(25);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "rights-gap")).toBe(0);
    expect(value(frame, "residual-copies")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-rights-gap-crit");
    const custom = frame.events.filter((event) => event.id === "request-incomplete");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(custom.length).toBe(1);
  });

  it("scores end-to-end rights coverage and additive residual copies", () => {
    const frame = runModel(model, { ...module.experiments[0].setup }, 20261110, 20);
    expect(value(frame, "rights-gap")).toBeCloseTo(58, 5);
    expect(value(frame, "residual-copies")).toBeCloseTo(58, 5);
    expect(frame.nodes.find((node) => node.id === "profile")?.health).toBe("crit");
    expect(frame.nodes.find((node) => node.id === "cache")?.health).toBe("crit");
    expect(frame.nodes.find((node) => node.id === "backup")?.health).toBe("crit");
  });

  it("restores request coverage when every system is discoverable and deletion is complete", () => {
    const frame = runModel(model, { ...module.experiments[0].fix }, 20261110, 20);
    expect(value(frame, "rights-gap")).toBe(0);
    expect(value(frame, "residual-copies")).toBe(0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("flags a new discoverability gap even when export is complete", () => {
    const frame = runModel(model, params("new-cache"), 20261110, 20);
    expect(value(frame, "rights-gap")).toBeCloseTo(23.5, 5);
    expect(value(frame, "rights-gap")).toBeGreaterThanOrEqual(10);
    expect(frame.nodes.find((node) => node.id === "cache")?.health).not.toBe("ok");
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
