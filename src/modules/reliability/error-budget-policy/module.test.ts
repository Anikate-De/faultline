import { describe, expect, it } from "vitest";
import {
  activeNodeIncident,
  activeThreshold,
  initModel,
  runModel,
  stepModel,
  TICK,
} from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { errorBudgetModel, module } from "./module";

const model = errorBudgetModel;
const presets = module.sims.budget.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("reliability-error-budget-policy model", () => {
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
    for (const node of frame.nodes) {
      expect(Number.isFinite(node.utilization ?? 0)).toBe(true);
      expect(node.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(node.utilization ?? 0).toBeLessThanOrEqual(1);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("loads healthy with no active threshold or failing node at t=0", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "budget-consumed")).toBe(100);
    expect(metricValue(frame, "budget-shortfall")).toBeGreaterThan(50);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("replaces the seed budget event with failure values on the first tick", () => {
    const frame = runModel(model, params("failure"), 20261110, 0.1);
    const event = frame.events[0];
    expect(event?.id).toBe("budget-window-open");
    expect(event?.detail).toContain("SLO 99.90%");
    expect(event?.detail).toContain("policy trigger at 100% of budget");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-budget-consumed-crit");
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("distinguishes a budget that is burning from one that is spent", () => {
    const peak = runModel(model, params("peak"), 20261110, 60);
    const failure = runModel(model, params("failure"), 20261110, 60);
    expect(metricValue(peak, "budget-consumed")).toBeGreaterThan(75);
    expect(metricValue(peak, "budget-consumed")).toBeLessThan(100);
    expect(metricValue(peak, "burn-rate")).toBeLessThan(metricValue(failure, "burn-rate"));
    expect(metricValue(failure, "policy-gap")).toBeGreaterThan(metricValue(peak, "policy-gap"));
  });

  it("shows that exceptions widen the gap between the trigger and the consequence", () => {
    const failure = runModel(model, params("failure"), 20261110, 60);
    const recovery = runModel(model, params("recovery"), 20261110, 60);
    expect(metricValue(failure, "policy-gap")).toBeGreaterThan(25);
    expect(metricValue(recovery, "policy-gap")).toBe(0);
    expect(metricValue(failure, "budget-shortfall")).toBeGreaterThan(0);
    expect(metricValue(recovery, "budget-shortfall")).toBe(0);
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
    expect(module.experiments[0]?.simId).toBe("budget");
    expect(module.meta.tags).toEqual([
      "error budget policy",
      "consequence",
      "exception",
      "freeze",
      "decision",
    ]);
  });
});
