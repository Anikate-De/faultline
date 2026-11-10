import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, retryStormModel } from "./module";

const model = retryStormModel;
const presets = module.sims["retry-storm"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("mesh-retry-storm model", () => {
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
      for (const item of values) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "amplification")).toBeGreaterThan(2.5);
    expect(value(frame, "dep-util")).toBeGreaterThan(90);
    expect(value(frame, "error-rate")).toBeGreaterThan(5);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "amplification")).toBeLessThan(1.2);
    expect(value(frame, "dep-util")).toBeLessThan(60);
  });

  it("warns without failing in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-amplification-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "retry-prevents-recovery").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "dependency-fault").length).toBe(1);
  });

  it("a retry budget bounds amplification and lets the dependency recover", () => {
    const storm = runModel(model, params("failure"), 20261110, 30);
    const bounded = runModel(model, params("budget"), 20261110, 30);
    expect(value(bounded, "amplification")).toBeLessThan(1.3);
    expect(value(bounded, "amplification")).toBeLessThan(value(storm, "amplification"));
    expect(value(bounded, "dep-util")).toBeLessThan(75);
    expect(activeThreshold(bounded, model.thresholds)).toBeNull();
  });

  it("a breaker cuts dependency load during the fault", () => {
    const storm = runModel(model, params("failure"), 20261110, 8);
    const protectedFrame = runModel(model, params("breaker"), 20261110, 8);
    expect(value(protectedFrame, "amplification")).toBeLessThan(1.2);
    expect(value(protectedFrame, "dep-util")).toBeLessThan(value(storm, "dep-util"));
    expect(protectedFrame.events.some((event) => event.id === "retry-breaker-open")).toBe(true);
    expect(value(protectedFrame, "error-rate")).toBe(100);
  });

  it("keeps metric series history for sparklines and charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    expect(frame.series["amplification"]?.length).toBeGreaterThan(1);
    expect(frame.metrics.find((item) => item.id === "amplification")?.trend?.length).toBeGreaterThan(1);
  });

  it("the failure preset stays critical after the injected fault ends", () => {
    const early = runModel(model, params("failure"), 20261110, 15);
    const late = runModel(model, params("failure"), 20261110, 60);
    expect(value(early, "amplification")).toBeGreaterThan(2.5);
    expect(value(late, "amplification")).toBeGreaterThan(2.5);
    expect(value(late, "dep-util")).toBeGreaterThan(90);
    expect(late.events.some((event) => event.id === "retry-prevents-recovery")).toBe(true);
  });

  it("zero retries keeps amplification at one even during the fault", () => {
    const frame = runModel(model, { ...params("failure"), retryAttempts: 0 }, 20261110, 8);
    expect(value(frame, "amplification")).toBeCloseTo(1, 5);
    expect(value(frame, "dep-util")).toBeCloseTo(50, 5);
    expect(value(frame, "error-rate")).toBe(100);
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
    for (const metric of fast.metrics) {
      const other = stepped.metrics.find((item) => item.id === metric.id);
      expect(other?.value).toBeCloseTo(metric.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(5);
    expect(module.sims["retry-storm"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.sims["retry-storm"].presets.length).toBe(6);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
