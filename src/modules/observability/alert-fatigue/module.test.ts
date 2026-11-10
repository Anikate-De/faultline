import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { fatigueModel, module } from "./module";

const model = fatigueModel;
const presets = module.sims.fatigue.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-alert-fatigue model", () => {
  it("is deterministic for the same seed and parameters", () => {
    expect(JSON.stringify(runModel(model, params("failure"), 42, 30))).toBe(
      JSON.stringify(runModel(model, params("failure"), 42, 30)),
    );
  });

  it("keeps every metric finite, non-negative, and utilization bounded", () => {
    const frame = runModel(model, params("failure"), 7, 40);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const node of frame.nodes) {
      expect(node.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(node.utilization ?? 0).toBeLessThanOrEqual(1);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it("loads the healthy preset at ok with no active threshold", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
    expect(metric(frame, "page-volume")).toBeLessThan(20);
    expect(metric(frame, "missed-incidents")).toBeLessThan(1);
  });

  it("crosses a critical threshold in the rule-sprawl failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metric(frame, "page-volume")).toBeGreaterThan(35);
    expect(metric(frame, "noise-pages")).toBeGreaterThan(30);
  });

  it("returns to ok within 60 simulated seconds of the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metric(frame, "missed-incidents")).toBeLessThan(1);
  });

  it("adds page volume without adding detection when rule count rises", () => {
    const base = runModel(model, { ...params("healthy"), rulesCount: 10 }, 20261110, 5);
    const more = runModel(model, { ...params("healthy"), rulesCount: 50 }, 20261110, 5);
    expect(metric(more, "page-volume")).toBeGreaterThan(metric(base, "page-volume"));
    expect(metric(more, "actionability")).toBeLessThan(metric(base, "actionability"));
    expect(metric(more, "missed-incidents")).toBeGreaterThanOrEqual(metric(base, "missed-incidents"));
  });

  it("keeps the experiment setup at 5.3 actionable pages and 88% detection", () => {
    const experiment = module.experiments[0];
    const frame = runModel(model, experiment.setup, 20261110, experiment.runFor);
    expect(metric(frame, "actionable-pages")).toBeCloseTo(5.28, 1);
    expect(metric(frame, "page-volume")).toBeGreaterThan(20);
    expect(metric(frame, "missed-incidents")).toBeCloseTo(0.72, 1);
  });

  it("shows the quiet-but-blind tradeoff: fewer pages and more missed incidents", () => {
    const frame = runModel(model, params("quiet-miss"), 20261110, 10);
    expect(metric(frame, "page-volume")).toBeLessThan(5);
    expect(metric(frame, "missed-incidents")).toBeGreaterThan(3);
  });

  it("keeps the first critical threshold event during deduplication", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-noise-pages-crit").length).toBe(1);
  });

  it("runFor matches stepping the same number of ticks", () => {
    const seconds = 12;
    const fast = runModel(model, params("peak"), 99, seconds);
    let stepped = initModel(model, params("peak"), 99);
    const rng = createRng(99);
    for (let index = 0; index < seconds / TICK; index++) {
      stepped = stepModel(model, stepped, params("peak"), rng);
    }
    expect(stepped.t).toBeCloseTo(fast.t, 5);
    for (const item of fast.metrics) {
      expect(stepped.metrics.find((other) => other.id === item.id)?.value).toBeCloseTo(item.value, 6);
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
