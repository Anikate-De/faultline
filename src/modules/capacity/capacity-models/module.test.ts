import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, capacityModelsModel } from "./module";

const model = capacityModelsModel;
const presets = module.sims["capacity-models"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;

describe("capacity-capacity-models model", () => {
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
    expect(frame.metrics.find((item) => item.id === "peak-utilization")?.value).toBeGreaterThan(85);
    expect(frame.metrics.find((item) => item.id === "p99-latency")?.value).toBeGreaterThan(800);
    expect(frame.metrics.find((item) => item.id === "model-gap")?.value).toBeGreaterThan(20);
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

  it("computes the failure-adjusted requirement from concurrency", () => {
    const frame = runModel(model, params("healthy"), 20261110, 30);
    const required = frame.metrics.find((item) => item.id === "required-instances")?.value ?? 0;
    expect(required).toBeGreaterThan(90);
    expect(required).toBeLessThan(100);
    expect(frame.metrics.find((item) => item.id === "provisioned-instances")?.value).toBe(100);
  });

  it("N+0 looks healthy until a failure domain removes capacity", () => {
    const nPlusZero = runModel(model, params("n-plus-zero"), 20261110, 60);
    const withDomain = runModel(model, { ...params("n-plus-zero"), failureDomainPct: 34 }, 20261110, 60);
    expect(activeThreshold(nPlusZero, model.thresholds)).toBeNull();
    expect(activeThreshold(withDomain, model.thresholds)?.severity).toBe("crit");
  });

  it("keeps the first failure-domain event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const events = frame.events.filter((event) => event.id === "failure-domain");
    expect(events.length).toBe(1);
    expect(events[0].severity).toBe("crit");
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
