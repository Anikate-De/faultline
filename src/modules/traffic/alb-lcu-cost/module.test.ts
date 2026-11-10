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
import { albLcuCostModel, module } from "./module";

const model = albLcuCostModel;
const presets = module.sims["lcu-cost"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 20) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("traffic-alb-lcu-cost model", () => {
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
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(frame.metrics.find((item) => item.id === "spend-index")?.value).toBeLessThan(1.25);
  });

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "spend-index")?.value).toBeGreaterThan(1.75);
    expect(frame.metrics.find((item) => item.id === "lcu-bytes")?.value).toBeGreaterThan(1_000);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const critical = frame.events.filter((event) => event.id === "threshold-spend-index-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["lcu-total"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("bills the highest dimension, not the sum", () => {
    const bytes = valueOf("failure", "lcu-bytes");
    const total = valueOf("failure", "lcu-total");
    const sum =
      valueOf("failure", "lcu-new") +
      valueOf("failure", "lcu-active") +
      valueOf("failure", "lcu-bytes") +
      valueOf("failure", "lcu-rules");
    expect(total).toBeCloseTo(bytes, 6);
    expect(total).toBeLessThan(sum);
    expect(activeThreshold(runModel(model, params("failure"), 20261110, 20), model.thresholds)?.threshold.id).toBe("bytes-per-request");
  });

  it("moves the dominant dimension to rules when the rule count is high", () => {
    const frame = runModel(model, params("rules"), 20261110, 20);
    expect(frame.metrics.find((item) => item.id === "lcu-rules")?.value).toBeGreaterThan(
      frame.metrics.find((item) => item.id === "lcu-bytes")?.value ?? 0,
    );
    expect(frame.metrics.find((item) => item.id === "lcu-rules")?.value ?? 0).toBeGreaterThanOrEqual(800);
    expect(frame.events.some((event) => event.id === "threshold-lcu-rules-crit")).toBe(true);
    expect(activeThreshold(frame, model.thresholds)?.threshold.id).toBe("lcu-rules");
  });

  it("charges no rule-evaluation LCU at 10 evaluations per request or fewer", () => {
    expect(valueOf("healthy", "lcu-rules")).toBe(0);
  });

  it("counts processed bytes in both directions", () => {
    expect(valueOf("healthy", "bytes-per-request")).toBe(6);
  });

  it("makes long-lived connections dominate the active dimension", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-active-connection-lcu");
    expect(experiment?.setup.requestsPerConnection).toBe(1);
    expect(experiment?.setup.connectionSeconds).toBe(600);
    const frame = runModel(model, experiment?.setup ?? {}, 20261110, experiment?.runFor ?? 20);
    const byId = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    expect(byId("lcu-active")).toBeGreaterThan(byId("lcu-new"));
    expect(byId("lcu-active")).toBeGreaterThan(byId("lcu-bytes"));
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
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(presets.length).toBe(5);
    expect(module.experiments.length).toBe(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
