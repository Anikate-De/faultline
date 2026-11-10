import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { crossAzRegionModel, module } from "./module";

const model = crossAzRegionModel;
const presets = module.sims["placement-path"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const node = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.nodes.find((item) => item.id === id);

describe("cloud-networking-cross-az-region model", () => {
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
    for (const item of frame.nodes) {
      expect(Number.isFinite(item.utilization ?? 0)).toBe(true);
      expect(item.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(item.utilization ?? 0).toBeLessThanOrEqual(1);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "latency")).toBeGreaterThan(500);
    expect(metricValue(frame, "cost-index")).toBeGreaterThan(80);
    expect(node(frame, "network")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "latency")).toBeLessThan(250);
    expect(metricValue(frame, "cost-index")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-latency-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "cross-boundary").length).toBe(1);
  });

  it("separates cross-AZ latency from cross-Region latency", () => {
    const sameAz = runModel(model, params("recovery"), 20261110, 20);
    const crossAz = runModel(model, params("healthy"), 20261110, 20);
    const crossRegion = runModel(model, params("region"), 20261110, 20);
    expect(metricValue(crossAz, "latency")).toBeGreaterThan(metricValue(sameAz, "latency"));
    expect(metricValue(crossRegion, "latency")).toBeGreaterThan(metricValue(crossAz, "latency"));
    expect(metricValue(crossRegion, "latency")).toBeLessThan(250);
  });

  it("makes the chatty protocol multiply the same per-hop delay", () => {
    const five = runModel(model, params("healthy"), 20261110, 20);
    const twentyFive = runModel(model, { ...params("healthy"), roundTrips: 25 }, 20261110, 20);
    expect(metricValue(twentyFive, "latency")).toBeGreaterThan(metricValue(five, "latency") + 20);
    expect(metricValue(twentyFive, "transfer-tb")).toBeGreaterThan(
      metricValue(five, "transfer-tb") * 4,
    );
  });

  it("warns on transfer volume while latency stays inside budget", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(metricValue(frame, "latency")).toBeLessThan(250);
    expect(metricValue(frame, "cost-index")).toBeGreaterThanOrEqual(40);
    expect(metricValue(frame, "cost-index")).toBeLessThan(80);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
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
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
