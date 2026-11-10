import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, vendorRiskModel } from "./module";

const model = vendorRiskModel;
const presets = module.sims["vendor-risk"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("compliance-vendor-risk model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "unassessed-critical")).toBe(0);
    expect(value(frame, "exit-gap")).toBe(0);
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
    expect(value(frame, "unassessed-critical")).toBeGreaterThanOrEqual(40);
    expect(value(frame, "exit-gap")).toBeGreaterThanOrEqual(50);
    expect(value(frame, "subprocessor-gap")).toBeGreaterThanOrEqual(40);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const custom = frame.events.filter((event) => event.id === "critical-vendor-uncovered");
    expect(custom.length).toBe(1);
    expect(custom[0].severity).toBe("crit");
  });

  it("reports tier gaps separately from assessment gaps", () => {
    const frame = runModel(
      model,
      { tiering: 50, assessment: 100, subprocessorVisibility: 100, exitReadiness: 100 },
      20261110,
      20,
    );
    expect(value(frame, "tier-gap")).toBe(50);
    expect(value(frame, "unassessed-critical")).toBe(0);
    expect(value(frame, "portfolio-exposure")).toBe(50);
    expect(frame.nodes.find((node) => node.id === "tier")?.health).toBe("crit");
  });

  it("derives the critical event from the largest gap", () => {
    const frame = runModel(
      model,
      { tiering: 100, assessment: 100, subprocessorVisibility: 50, exitReadiness: 20 },
      20261110,
      20,
    );
    const event = frame.events.find((item) => item.id === "critical-vendor-uncovered");
    expect(event?.metricId).toBe("exit-gap");
    expect(event?.nodeId).toBe("exit");
    expect(event?.title).toBe("A critical vendor has no tested exit");
  });

  it("does not let a completed assessment compensate for an untested exit", () => {
    const frame = runModel(
      model,
      { tiering: 100, assessment: 100, subprocessorVisibility: 100, exitReadiness: 0 },
      20261110,
      20,
    );
    expect(value(frame, "unassessed-critical")).toBe(0);
    expect(value(frame, "exit-gap")).toBe(100);
    expect(value(frame, "portfolio-exposure")).toBe(100);
    expect(frame.nodes.find((node) => node.id === "exit")?.health).toBe("crit");
  });

  it("treats concentration as a portfolio failure even when every vendor is assessed", () => {
    const frame = runModel(model, params("concentration"), 20261110, 20);
    expect(value(frame, "tier-gap")).toBe(0);
    expect(value(frame, "unassessed-critical")).toBe(0);
    expect(value(frame, "subprocessor-gap")).toBe(50);
    expect(value(frame, "exit-gap")).toBe(80);
    expect(value(frame, "portfolio-exposure")).toBeGreaterThanOrEqual(50);
  });

  it("restores the portfolio when subcontractors and exit are reviewed", () => {
    const frame = runModel(model, { ...module.experiments[0].fix }, 20261110, 20);
    expect(value(frame, "portfolio-exposure")).toBe(0);
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
    expect(presets.length).toBe(5);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
