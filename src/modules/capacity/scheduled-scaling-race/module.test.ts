import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, scheduledScalingRaceModel } from "./module";

const model = scheduledScalingRaceModel;
const presets = module.sims["scheduled-scaling-race"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (id: string, seconds: number, presetId = "failure") =>
  runModel(model, params(presetId), 20261110, seconds).metrics.find((item) => item.id === id)?.value ?? 0;

describe("capacity-scheduled-scaling-race model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 45);
    const b = runModel(model, params("failure"), 42, 45);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative utilization", () => {
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
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 45 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "error-rate")?.value).toBeGreaterThan(5);
    expect(frame.metrics.find((item) => item.id === "fleet-utilization")?.value).toBeGreaterThan(90);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-error-rate-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("is healthy before the scheduled action and fails after it", () => {
    const before = runModel(model, params("failure"), 20261110, 29);
    const after = runModel(model, params("failure"), 20261110, 40);
    const error = (frame: typeof before) => frame.metrics.find((item) => item.id === "error-rate")?.value ?? 0;
    expect(error(before)).toBeLessThan(1);
    expect(activeThreshold(before, model.thresholds)?.severity).not.toBe("crit");
    expect(error(after)).toBeGreaterThan(5);
    expect(activeThreshold(after, model.thresholds)?.severity).toBe("crit");
  });

  it("a minimum floor prevents the scale-down from collapsing capacity", () => {
    const frame = runModel(model, { ...params("failure"), minCapacity: 40 }, 20261110, 40);
    expect(frame.metrics.find((item) => item.id === "error-rate")?.value).toBeLessThan(1);
    expect(frame.metrics.find((item) => item.id === "capacity-instances")?.value).toBeGreaterThanOrEqual(40);
  });

  it("a longer cooldown delays recovery", () => {
    const short = metricValue("error-rate", 100, "failure");
    const long = metricValue("error-rate", 100, "cooldown");
    expect(short).toBeLessThan(30);
    expect(long).toBeGreaterThan(short);
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

  it("a change freeze suppresses the scheduled action", () => {
    const frame = runModel(model, params("freeze"), 20261110, 60);
    expect(frame.events.some((event) => event.id === "freeze-suppressed")).toBe(true);
    expect(frame.events.some((event) => event.id === "scheduled-scale-down")).toBe(false);
    expect(frame.metrics.find((metric) => metric.id === "error-rate")?.value ?? 0).toBeLessThan(1);
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(6);
    expect(presets.length).toBe(6);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "freeze", "cooldown"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
