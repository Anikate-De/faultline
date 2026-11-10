import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { fargateColdStartModel, module } from "./module";

const model = fargateColdStartModel;
const presets = module.sims["fargate-cold-start"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricOf = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const valueOf = (id: string, metricId: string, seconds = 10) =>
  metricOf(runModel(model, params(id), 20261110, seconds), metricId);

describe("containers-fargate-cold-start model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or invalid utilization", () => {
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
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    const running = runModel(model, params("healthy"), 20261110, 1);
    expect(activeThreshold(running, model.thresholds)).toBeNull();
    expect(activeNodeIncident(running)).toBeNull();
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 40);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(valueOf("failure", "request-shortfall", 40)).toBeGreaterThanOrEqual(500);
    expect(valueOf("failure", "time-to-serve")).toBeGreaterThanOrEqual(90);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricOf(frame, "request-shortfall")).toBe(0);
    expect(metricOf(frame, "ready-tasks")).toBeGreaterThanOrEqual(40);
  });

  it("keeps one critical event for a single threshold crossing", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    const critical = frame.events.filter((event) => event.id === "threshold-time-to-serve-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("shows a positive lead gap when cold start exceeds the lead time", () => {
    const failure = runModel(model, params("failure"), 3, 1);
    const recovery = runModel(model, params("recovery"), 3, 1);
    expect(metricOf(failure, "lead-gap")).toBeGreaterThanOrEqual(90);
    expect(metricOf(recovery, "lead-gap")).toBe(0);
  });

  it("avoids unserved demand when the scale-out starts before the spike", () => {
    const late = runModel(model, params("failure"), 3, 40);
    const early = runModel(model, params("recovery"), 3, 40);
    expect(metricOf(late, "request-shortfall")).toBeGreaterThanOrEqual(500);
    expect(metricOf(early, "request-shortfall")).toBe(0);
    expect(metricOf(early, "ready-tasks")).toBeGreaterThan(40);
  });

  it("runFor matches stepping the same number of ticks", () => {
    const seconds = 12;
    const fast = runModel(model, params("recovery"), 99, seconds);
    let stepped = initModel(model, params("recovery"), 99);
    const rng = createRng(99);
    for (let index = 0; index < seconds / TICK; index++) {
      stepped = stepModel(model, stepped, params("recovery"), rng);
    }
    expect(stepped.t).toBeCloseTo(fast.t, 5);
    for (const item of fast.metrics) {
      const other = stepped.metrics.find((metric) => metric.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(4);
    expect(presets.length).toBe(5);
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
