import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { baaModel, module } from "./module";

const model = baaModel;
const presets = module.sims["baa"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("compliance-baa model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
    expect(value(frame, "baa-exposure")).toBe(0);
    expect(value(frame, "gate-bypass")).toBe(0);
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
    expect(value(frame, "baa-exposure")).toBeGreaterThanOrEqual(50);
    expect(value(frame, "gate-bypass")).toBeGreaterThanOrEqual(40);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "baa-exposure")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const exposure = frame.events.filter((event) => event.id === "threshold-baa-exposure-crit");
    const bypass = frame.events.filter((event) => event.id === "threshold-gate-bypass-crit");
    const customExposure = frame.events.filter((event) => event.id === "phi-to-vendor-without-baa");
    const customBypass = frame.events.filter((event) => event.id === "baa-gate-bypassed");
    expect(exposure.length).toBe(1);
    expect(bypass.length).toBe(1);
    expect(customExposure.length).toBe(1);
    expect(customBypass.length).toBe(1);
  });

  it("blocks PHI egress when the vendor is covered and the gate is enforced", () => {
    const frame = runModel(model, { ...module.experiments[0].fix }, 20261110, 20);
    expect(value(frame, "baa-exposure")).toBe(0);
    expect(value(frame, "gate-bypass")).toBe(0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("shows the gate blocking non-compliant sends before a BAA exists", () => {
    const frame = runModel(model, { baaCoverage: 0, phiShare: 100, gateEnforcement: 100 }, 20261110, 20);
    expect(value(frame, "baa-exposure")).toBe(0);
    expect(value(frame, "blocked")).toBe(1000);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("warns when a tenth of egress bypasses the gate", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(value(frame, "gate-bypass")).toBe(10);
    expect(frame.nodes.find((node) => node.id === "gate")?.health).toBe("warn");
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
