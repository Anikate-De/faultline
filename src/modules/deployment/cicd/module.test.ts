import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { cicdModel as model, module } from "./module";

const presets = module.sims.cicd.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("deployment-cicd model", () => {
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
    expect(value(frame, "lead-time")).toBeGreaterThan(60);
    expect(value(frame, "bypass-rate")).toBeGreaterThan(50);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "lead-time")).toBeLessThan(30);
    expect(value(frame, "feedback-time")).toBeLessThan(10);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-lead-time-crit");
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("reduces lead time with parallelism and caching", () => {
    const slow = runModel(model, params("failure"), 20261110, 30);
    const parallel = runModel(model, { ...params("failure"), parallelism: 8 }, 20261110, 30);
    const cached = runModel(model, { ...params("failure"), cacheHit: 80 }, 20261110, 30);
    expect(value(parallel, "lead-time")).toBeLessThan(value(slow, "lead-time"));
    expect(value(cached, "lead-time")).toBeLessThan(value(slow, "lead-time"));
  });

  it("adds retry time when tests are flaky", () => {
    const stable = runModel(model, { ...params("healthy"), flakyRate: 0 }, 20261110, 30);
    const flaky = runModel(model, { ...params("healthy"), flakyRate: 15 }, 20261110, 30);
    expect(value(flaky, "retry-time")).toBeGreaterThan(value(stable, "retry-time"));
    expect(value(flaky, "lead-time")).toBeGreaterThan(value(stable, "lead-time"));
  });

  it("lets a manual gate dominate a fast pipeline", () => {
    const frame = runModel(model, params("manual-gate"), 20261110, 30);
    expect(value(frame, "approval-share")).toBeGreaterThan(80);
    expect(value(frame, "feedback-time")).toBeLessThan(10);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
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
    expect(model.params).toHaveLength(4);
    expect(presets).toHaveLength(5);
    expect(module.experiments).toHaveLength(1);
    expect(module.sims.cicd.experimentIds).toHaveLength(1);
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
