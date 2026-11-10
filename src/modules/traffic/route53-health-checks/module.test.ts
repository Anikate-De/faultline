import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, route53HealthChecksModel } from "./module";

const model = route53HealthChecksModel;
const presets = module.sims["route53-health-checks"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 20) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("traffic-route53-health-checks model", () => {
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
    expect(frame.metrics.find((item) => item.id === "failed-requests")?.value).toBe(0);
  });

  it("uses the healthy check settings for the default parameters", () => {
    expect(model.params.find((item) => item.id === "failureThreshold")?.value).toBe(2);
    expect(model.params.find((item) => item.id === "checkInterval")?.value).toBe(10);
    const frame = initModel(model, {}, 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "failed-requests")?.value).toBeGreaterThan(90);
    expect(frame.metrics.find((item) => item.id === "check-pass")?.value).toBe(100);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "request-path-failing").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "check-blind").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["failed-requests"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("a shallow check never sees the failure", () => {
    expect(valueOf("failure", "check-pass")).toBe(100);
    expect(valueOf("failure", "undetected-failure")).toBe(100);
    expect(valueOf("failure", "failed-requests")).toBeGreaterThan(99);
  });

  it("a deep check detects after interval times threshold and moves traffic", () => {
    const frame = runModel(model, params("slow-check"), 20261110, 160);
    expect(frame.metrics.find((item) => item.id === "check-pass")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "traffic-primary")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "detection-seconds")?.value).toBe(150);
  });

  it("insights reflect the check state after the run, not the initial state", () => {
    const p = params("slow-check");
    const frame = runModel(model, p, 20261110, 160);
    const notes = model.insights(frame, p).join(" ");
    expect(notes).toContain("check flipped");
    expect(notes).not.toContain("has not flipped");
  });

  it("uses 10 seconds when the interval is in the fast range", () => {
    const frame = runModel(
      model,
      { ...params("failure"), checkDepth: 1, checkInterval: 10, failureThreshold: 2 },
      20261110,
      30,
    );
    expect(frame.metrics.find((item) => item.id === "detection-seconds")?.value).toBe(20);
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
    expect(module.sims["route53-health-checks"].alternateVisuals).toContain("timeline");
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.experiments.length).toBe(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
