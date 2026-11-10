import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { albConnectionLimitModel, module } from "./module";

const model = albConnectionLimitModel;
const presets = module.sims["alb-connection-limit"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 20) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("traffic-alb-connection-limit model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative utilization", () => {
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

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "rejected")?.value).toBeGreaterThan(100);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const critical = frame.events.filter((event) => event.id === "threshold-rejected-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "per-alb-saturated").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["active-per-alb"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("sharding divides per-ALB demand and removes rejections", () => {
    expect(valueOf("sharded", "active-per-alb")).toBeLessThan(valueOf("failure", "active-per-alb"));
    expect(valueOf("sharded", "rejected")).toBe(0);
    expect(valueOf("sharded", "connection-utilization")).toBeLessThan(80);
  });

  it("raising the illustrative ceiling does not help once the node ceiling binds", () => {
    expect(valueOf("quota-raised", "rejected")).toBeCloseTo(valueOf("failure", "rejected"), 6);
    expect(valueOf("quota-raised", "active-per-alb")).toBeCloseTo(valueOf("failure", "active-per-alb"), 6);
  });

  it("an NLB alone does not remove the per-ALB limit", () => {
    const base = runModel(model, params("failure"), 20261110, 20);
    const withNlb = runModel(model, { ...params("failure"), nlbEnabled: 1 }, 20261110, 20);
    expect(valueOf("failure", "rejected")).toBeCloseTo(
      withNlb.metrics.find((item) => item.id === "rejected")?.value ?? 0,
      6,
    );
    expect(withNlb.metrics.find((item) => item.id === "p99")?.value ?? 0).toBeGreaterThan(
      base.metrics.find((item) => item.id === "p99")?.value ?? 0,
    );
  });

  it("reports rejected connections and failed attempts, not HTTP 5xx", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.metrics.some((item) => item.id === "rejected")).toBe(true);
    expect(frame.metrics.some((item) => item.id === "failed-attempts")).toBe(true);
    expect(frame.metrics.some((item) => item.id === "five-xx")).toBe(false);
    expect(frame.summary).toContain("Rejected connections");
    expect(frame.summary).not.toContain("5xx");
  });

  it("runs the ceiling experiment at the raised value it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-quota-ceiling");
    expect(experiment?.setup.quotaPerAlb).toBe(5_000_000);
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
    expect(model.params.length).toBe(6);
    expect(module.sims["alb-connection-limit"].alternateVisuals).toContain("timeline");
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "quota-raised", "sharded"]),
    );
    expect(module.experiments.length).toBe(2);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
