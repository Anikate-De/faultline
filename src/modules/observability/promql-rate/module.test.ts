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
import { module, promqlRateModel } from "./module";

const model = promqlRateModel;
const presets = module.sims["promql-rate"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-promql-rate model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
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

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "spike-error")).toBeGreaterThan(40);
    expect(metricValue(frame, "sample-shortfall")).toBeGreaterThanOrEqual(2);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first counter-reset event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const events = frame.events.filter((event) => event.id === "rate-reset");
    expect(events.length).toBe(1);
  });

  it("shortens the window into an aliased spike", () => {
    const healthy = runModel(model, params("healthy"), 20261110, 30);
    const failure = runModel(model, params("failure"), 20261110, 60);
    expect(metricValue(failure, "spike-error")).toBeGreaterThan(40);
    expect(metricValue(failure, "query-rate")).toBeGreaterThan(metricValue(failure, "true-rate"));
    expect(metricValue(healthy, "samples")).toBe(20);
    expect(metricValue(healthy, "spike-error")).toBeLessThan(15);
  });

  it("counts a left-open range and reports no result with one sample", () => {
    const noResult = runModel(
      model,
      { ...params("healthy"), queryWindow: 15, scrapeInterval: 15 },
      20261110,
      5,
    );
    expect(metricValue(noResult, "samples")).toBe(1);
    expect(metricValue(noResult, "query-rate")).toBe(0);
    expect(noResult.summary).toContain("No result");
    expect(noResult.metrics.find((item) => item.id === "query-rate")?.label).toContain("No result");
  });

  it("widening the window fixes the estimate without changing the burst", () => {
    const fixed = runModel(model, { ...params("failure"), queryWindow: 300 }, 20261110, 60);
    expect(activeThreshold(fixed, model.thresholds)).toBeNull();
    expect(metricValue(fixed, "spike-error")).toBeLessThan(15);
    expect(metricValue(fixed, "sample-shortfall")).toBe(0);
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
    expect(model.params.length).toBe(4);
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
