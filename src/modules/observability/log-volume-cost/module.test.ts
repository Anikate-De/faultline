import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { logVolumeCostModel, module } from "./module";

const model = logVolumeCostModel;
const presets = module.sims["log-volume-cost"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-log-volume-cost model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "daily-spend")).toBeLessThan(100);
    expect(value(frame, "retained-volume")).toBeLessThan(10);
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
    for (const series of Object.values(frame.series)) {
      for (const item of series) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "daily-spend")).toBeGreaterThan(600);
    expect(value(frame, "retained-volume")).toBeGreaterThan(25);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "daily-spend")).toBeLessThan(300);
    expect(value(frame, "retained-volume")).toBeLessThan(10);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-daily-spend-crit");
    const custom = frame.events.filter((event) => event.id === "log-budget-exhausted");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(custom.length).toBe(1);
  });

  it("shows that retention changes storage, not ingest", () => {
    const short = runModel(model, params("failure"), 20261110, 20);
    const long = runModel(model, { ...params("failure"), retentionDays: 60 }, 20261110, 20);
    expect(value(long, "retained-volume")).toBeGreaterThan(value(short, "retained-volume"));
    expect(value(long, "daily-spend")).toBeGreaterThan(value(short, "daily-spend"));
    expect(value(long, "ingest-per-request")).toBeCloseTo(value(short, "ingest-per-request"), 6);
  });

  it("shows that sampling debug cuts volume without touching request rate", () => {
    const unsampled = runModel(model, { ...params("failure"), debugSampling: 100 }, 20261110, 20);
    const sampled = runModel(model, { ...params("failure"), debugSampling: 5 }, 20261110, 20);
    expect(value(sampled, "daily-spend")).toBeLessThan(value(unsampled, "daily-spend"));
    expect(value(sampled, "ingest-per-request")).toBeLessThan(value(unsampled, "ingest-per-request"));
    expect(value(sampled, "cost-per-request")).toBeLessThan(value(unsampled, "cost-per-request"));
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
    expect(model.params.length).toBe(5);
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
