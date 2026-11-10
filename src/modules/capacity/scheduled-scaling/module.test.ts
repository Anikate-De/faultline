import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, scheduledScalingModel } from "./module";

const model = scheduledScalingModel;
const presets = module.sims["scheduled-scaling"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;

describe("capacity-scheduled-scaling model", () => {
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
      for (const item of values) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("is healthy at the start and end of the healthy preset", () => {
    expect(activeThreshold(initModel(model, params("healthy"), 20261110), model.thresholds)).toBeNull();
    const frame = runModel(model, params("healthy"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("crosses critical within 60 simulated seconds when the schedule lands late", () => {
    const frame = runModel(model, params("failure"), 20261110, 50);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "error-rate")?.value).toBeGreaterThan(5);
    expect(frame.events.some((event) => event.id === "schedule-outside-window")).toBe(true);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the peak preset saturated without crossing critical", () => {
    const frame = runModel(model, params("peak"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("fires the action at the local hour implied by the UTC offset", () => {
    const frame = runModel(model, params("healthy"), 20261110, 60);
    const applied = frame.events.find((event) => event.id === "scheduled-action-applied");
    expect(applied).toBeDefined();
    expect(applied?.at).toBeCloseTo(20, 0);
  });

  it("does not fire an action that lands outside the window", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.some((event) => event.id === "scheduled-action-applied")).toBe(false);
    expect(frame.metrics.find((item) => item.id === "scheduled-target")?.value).toBeLessThan(24);
  });

  it("agrees between metric thresholds and node state", () => {
    const frame = runModel(model, params("failure"), 20261110, 50);
    expect(activeNodeIncident(frame)?.severity).toBe("crit");
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("preserves engine flags across steps", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(frame.flags.seed).toBe(20261110);
    expect(frame.flags.seriesSeeded).toBe(1);
    expect(typeof frame.flags.paramsKey).toBe("string");
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
