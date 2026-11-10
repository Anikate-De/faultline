import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, peakEventsModel } from "./module";

const model = peakEventsModel;
const presets = module.sims["peak-events"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;

describe("capacity-peak-events model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 75);
    const b = runModel(model, params("failure"), 42, 75);
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
      for (const point of values) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "error-rate")?.value).toBeGreaterThan(5);
    expect(frame.metrics.find((item) => item.id === "utilization")?.value).toBeGreaterThan(90);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the healthy preset ok and the tight plan at warning", () => {
    const healthy = runModel(model, params("healthy"), 20261110, 60);
    const peak = runModel(model, params("peak"), 20261110, 60);
    expect(activeThreshold(healthy, model.thresholds)).toBeNull();
    expect(activeThreshold(peak, model.thresholds)?.severity).toBe("warn");
  });

  it("a full test without pre-scaling still misses the event ramp", () => {
    const testedOnly = runModel(model, params("tested-only"), 20261110, 60);
    const planned = runModel(model, { ...params("tested-only"), preScaleLeadMin: 30 }, 20261110, 60);
    expect(activeThreshold(testedOnly, model.thresholds)?.severity).toBe("crit");
    expect(activeThreshold(planned, model.thresholds)).toBeNull();
    expect(planned.metrics.find((item) => item.id === "error-rate")?.value ?? 0).toBeLessThan(1);
  });

  it("pre-scaling makes capacity warm before the event", () => {
    const frame = runModel(model, params("recovery"), 20261110, 20);
    expect(frame.events.some((event) => event.id === "prescale-ready")).toBe(true);
    expect(frame.metrics.find((item) => item.id === "capacity-instances")?.value ?? 0).toBeGreaterThan(200);
  });

  it("keeps the first event-start event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 75);
    const events = frame.events.filter((event) => event.id === "event-start");
    expect(events.length).toBe(1);
    expect(events[0].severity).toBe("crit");
  });

  it("a broken freeze removes usable capacity", () => {
    const frozen = runModel(model, { ...params("failure"), changeFreeze: 1 }, 20261110, 35);
    const broken = runModel(model, params("failure"), 20261110, 35);
    const capacity = (frame: typeof frozen) => frame.metrics.find((item) => item.id === "capacity-instances")?.value ?? 0;
    expect(capacity(broken)).toBeCloseTo(capacity(frozen), 6);
    expect(broken.metrics.find((item) => item.id === "utilization")?.value ?? 0).toBeGreaterThan(
      frozen.metrics.find((item) => item.id === "utilization")?.value ?? 0,
    );
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
    expect(model.params.length).toBe(4);
    expect(presets.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
