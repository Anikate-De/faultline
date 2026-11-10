import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { freezeWindowsModel as model, module } from "./module";

const presets = module.sims["change-freeze"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("deployment-freeze-windows model", () => {
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
    for (const node of frame.nodes) {
      expect(Number.isFinite(node.utilization ?? 0)).toBe(true);
      expect(node.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(node.utilization ?? 0).toBeLessThanOrEqual(1);
    }
    for (const series of Object.values(frame.series)) {
      for (const point of series) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "emergency-lead-time")).toBeGreaterThan(4);
    expect(value(frame, "bypass-share")).toBeGreaterThan(40);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "emergency-lead-time")).toBeLessThan(2);
    expect(value(frame, "bypass-share")).toBeLessThan(15);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-emergency-lead-time-crit");
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("concentrates more risk as the freeze gets longer", () => {
    const short = runModel(model, params("healthy"), 20261110, 30);
    const long = runModel(model, params("failure"), 20261110, 30);
    expect(value(long, "deferred-backlog")).toBeGreaterThan(value(short, "deferred-backlog") * 5);
    expect(value(long, "thaw-rate")).toBeGreaterThan(value(short, "thaw-rate"));
  });

  it("raises bypass risk when the exception path is slower", () => {
    const fast = runModel(model, { ...params("healthy"), exceptionMinutes: 30 }, 20261110, 30);
    const slow = runModel(model, { ...params("healthy"), exceptionMinutes: 180 }, 20261110, 30);
    expect(value(slow, "bypass-share")).toBeGreaterThan(value(fast, "bypass-share"));
    expect(value(slow, "emergency-lead-time")).toBeGreaterThan(value(fast, "emergency-lead-time"));
  });

  it("the experiment setup fails and its fix clears", () => {
    const experiment = module.experiments[0];
    if (!experiment?.fix) throw new Error("Missing experiment fix");
    const before = runModel(model, experiment.setup, 20261110, experiment.runFor);
    const after = runModel(model, experiment.fix, 20261110, experiment.runFor);
    expect(activeThreshold(before, model.thresholds)?.severity).toBe("crit");
    expect(activeThreshold(after, model.thresholds)).toBeNull();
  });

  it("preserves flags across steps", () => {
    const first = initModel(model, params("failure"), 99);
    const next = stepModel(model, first, params("failure"), createRng(99));
    expect(next.flags.seed).toBe(99);
    expect(next.flags.paramsKey).toBe(JSON.stringify(params("failure")));
    expect(next.flags.seriesSeeded).toBe(1);
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
      const other = stepped.metrics.find((entry) => entry.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params).toHaveLength(3);
    expect(presets).toHaveLength(4);
    expect(module.experiments).toHaveLength(1);
    expect(module.sims["change-freeze"].experimentIds).toHaveLength(1);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(model.thresholds.length).toBeGreaterThanOrEqual(3);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
