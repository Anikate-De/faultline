import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, applyPresetFrame, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, stepScalingModel } from "./module";

const model = stepScalingModel;
const presets = module.sims["step-scaling"].presets;
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

describe("containers-step-scaling model", () => {
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

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(valueOf("failure", "task-shortfall", 30)).toBeGreaterThanOrEqual(4);
    expect(valueOf("failure", "p99", 30)).toBeGreaterThanOrEqual(800);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricOf(frame, "task-shortfall")).toBe(0);
    expect(metricOf(frame, "p99")).toBeLessThan(300);
  });

  it("keeps one critical event for a single threshold crossing", () => {
    const frame = runModel(model, params("failure"), 20261110, 6);
    const critical = frame.events.filter((event) => event.id === "threshold-task-shortfall-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("keeps warm capacity through the trough with a longer scale-in hold", () => {
    const flapping = runModel(model, params("failure"), 3, 25);
    const stabilized = runModel(model, params("recovery"), 3, 25);
    expect(metricOf(flapping, "tasks")).toBeLessThanOrEqual(8);
    expect(metricOf(stabilized, "tasks")).toBeGreaterThanOrEqual(16);
    expect(metricOf(stabilized, "task-shortfall")).toBe(0);
  });

  it("starts the recovery preset healthy with warm capacity", () => {
    const frame = applyPresetFrame(model, preset("recovery"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricOf(frame, "ready-tasks")).toBeGreaterThanOrEqual(21);
  });

  it("scales out when demand rises above the threshold", () => {
    const frame = runModel(model, params("failure"), 3, 6);
    expect(metricOf(frame, "tasks")).toBeGreaterThan(12);
    expect(metricOf(frame, "ready-tasks")).toBeGreaterThan(10);
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
    expect(model.params.length).toBe(5);
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
