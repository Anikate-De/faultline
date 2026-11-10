import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { fargateSpotModel, module } from "./module";

const model = fargateSpotModel;
const presets = module.sims["fargate-spot"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 10) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("containers-fargate-spot model", () => {
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
    expect(valueOf("failure", "capacity-shortfall")).toBeGreaterThanOrEqual(25);
    expect(valueOf("failure", "lost-in-flight")).toBeGreaterThanOrEqual(5);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(valueOf("recovery", "capacity-shortfall")).toBe(0);
    expect(valueOf("recovery", "lost-in-flight")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-capacity-shortfall-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("measures the on-demand base separately from the Spot share", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), spotShare: 50, onDemandBase: 4, drainSeconds: 120, interruptions: 0 },
      3,
      5,
    );
    expect(frame.metrics.find((item) => item.id === "available-tasks")?.value).toBe(12);
    expect(frame.metrics.find((item) => item.id === "spot-exposure")?.value).toBeCloseTo(33.333, 3);
    expect(frame.nodes.find((node) => node.id === "on-demand")?.meta?.tasks).toBe(8);
    expect(frame.nodes.find((node) => node.id === "spot")?.meta?.tasks).toBe(4);
  });

  it("loses in-flight work when the stop window is shorter than the drain", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), spotShare: 100, onDemandBase: 4, drainSeconds: 30, interruptions: 1 },
      3,
      5,
    );
    expect(frame.metrics.find((item) => item.id === "lost-in-flight")?.value).toBe(6.25);
    expect(frame.metrics.find((item) => item.id === "capacity-shortfall")?.value).toBeCloseTo(8.333, 3);
  });

  it("protects the service with a ten-task on-demand floor", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), spotShare: 100, onDemandBase: 10, drainSeconds: 120, interruptions: 2 },
      3,
      5,
    );
    expect(frame.metrics.find((item) => item.id === "available-tasks")?.value).toBe(10);
    expect(frame.metrics.find((item) => item.id === "lost-in-flight")?.value).toBe(0);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("preserves the seed and recorded parameters across a step", () => {
    const frame = initModel(model, params("healthy"), 11);
    const next = stepModel(model, frame, params("failure"), createRng(11));
    expect(next.flags.seed).toBe(11);
    const key = String(next.flags.paramsKey);
    expect(key).toContain("spotShare");
    expect(key).toContain("drainSeconds");
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
