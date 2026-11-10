import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, observabilityCostModel } from "./module";

const model = observabilityCostModel;
const presets = module.sims["observability-cost"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (id: string, seconds: number, presetId = "failure") =>
  runModel(model, params(presetId), 20261110, seconds).metrics.find((item) => item.id === id)?.value ?? 0;

describe("capacity-observability-cost model", () => {
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
      for (const point of values) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "telemetry-cost-per-mreq")?.value).toBeGreaterThan(0.28);
    expect(frame.metrics.find((item) => item.id === "active-series")?.value).toBeGreaterThan(40_000);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("is healthy at baseline and critical after a cardinality ramp", () => {
    const healthy = runModel(model, params("healthy"), 20261110, 60);
    const failure = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(healthy, model.thresholds)).toBeNull();
    expect(activeThreshold(failure, model.thresholds)?.severity).toBe("crit");
    expect(healthy.metrics.find((item) => item.id === "blind-spot")?.value).toBe(0);
  });

  it("keeps the first cardinality event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const events = frame.events.filter((event) => event.id === "cardinality-spike");
    expect(events.length).toBe(1);
    expect(events[0].severity).toBe("warn");
  });

  it("shows a cheaper bill with a coverage gap in the blind-cut preset", () => {
    const frame = runModel(model, params("blind-cut"), 20261110, 30);
    const cost = frame.metrics.find((item) => item.id === "telemetry-cost-per-mreq")?.value ?? 0;
    const blind = frame.metrics.find((item) => item.id === "blind-spot")?.value ?? 0;
    expect(cost).toBeLessThan(0.16);
    expect(blind).toBeGreaterThan(25);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("removing the high-cardinality label cuts cost without a coverage gap", () => {
    const before = runModel(model, params("failure"), 20261110, 30);
    const after = runModel(model, { ...params("failure"), cardinality: 8_000 }, 20261110, 30);
    expect(value("telemetry-cost-per-mreq", 30)).toBeGreaterThan(0.28);
    expect(after.metrics.find((item) => item.id === "telemetry-cost-per-mreq")?.value ?? 0).toBeLessThan(0.16);
    expect(before.metrics.find((item) => item.id === "blind-spot")?.value ?? 0).toBe(0);
    expect(after.metrics.find((item) => item.id === "blind-spot")?.value ?? 0).toBe(0);
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
    expect(model.params.length).toBe(5);
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
