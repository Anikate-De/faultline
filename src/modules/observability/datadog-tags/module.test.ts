import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { datadogTagsModel, module } from "./module";

const model = datadogTagsModel;
const presets = module.sims["datadog-tags"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-datadog-tags model", () => {
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
    expect(value(frame, "series")).toBeGreaterThan(25_000);
    expect(value(frame, "query-p95")).toBeGreaterThan(250);
    expect(value(frame, "cost-index")).toBeGreaterThan(2.5);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "series")).toBe(2_400);
    expect(value(frame, "cost-index")).toBeCloseTo(1, 5);
  });

  it("warns without failing in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-series-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "high-cardinality-tag").length).toBe(1);
  });

  it("billable series follow unique tag combinations, not submission frequency", () => {
    const healthy = runModel(model, params("healthy"), 20261110, 20);
    const failure = runModel(model, params("failure"), 20261110, 20);
    expect(value(healthy, "series")).toBe(2_400);
    expect(value(failure, "series")).toBe(32_000);
    expect(value(failure, "series-per-host")).toBeGreaterThan(100);
    expect(value(healthy, "series-per-host")).toBeLessThan(20);
  });

  it("keeps metric series history for sparklines and charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    expect(frame.series["series"]?.length).toBeGreaterThan(1);
    expect(frame.metrics.find((item) => item.id === "series")?.trend?.length).toBeGreaterThan(1);
  });

  it("a wider query window raises latency without changing series or cost", () => {
    const narrow = runModel(model, params("failure"), 20261110, 10);
    const wide = runModel(model, { ...params("failure"), queryWindow: 12 }, 20261110, 10);
    const series = value(wide, "series");
    expect(series).toBe(value(narrow, "series"));
    expect(value(wide, "cost-index")).toBeCloseTo(value(narrow, "cost-index"), 5);
    expect(value(wide, "query-p95")).toBeGreaterThan(value(narrow, "query-p95"));
  });

  it("removing the user tag restores the baseline series and bill index", () => {
    const tagged = runModel(model, params("failure"), 20261110, 20);
    const cleaned = runModel(model, params("recovery"), 20261110, 20);
    expect(value(cleaned, "series")).toBeLessThan(value(tagged, "series"));
    expect(value(cleaned, "cost-index")).toBeLessThan(1.1);
    expect(value(cleaned, "query-p95")).toBeLessThan(200);
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
    expect(module.sims["datadog-tags"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
