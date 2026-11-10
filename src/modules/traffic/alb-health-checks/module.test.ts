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
import { albHealthChecksModel, module } from "./module";

const model = albHealthChecksModel;
const presets = module.sims["alb-health-checks"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 20) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("traffic-alb-health-checks model", () => {
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

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "healthy-targets")?.value).toBe(0);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("fires the all-targets-removed event once", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "all-targets-removed")).toHaveLength(1);
    expect(frame.flags.allRemoved).toBe(1);
    expect(frame.flags.seed).toBe(20261110);
    expect(typeof frame.flags.paramsKey).toBe("string");
  });

  it("reports the raw failed-check count, not the threshold", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const targets = frame.nodes.find((node) => node.id === "targets");
    expect(targets?.detail).toContain("3 failed checks");
    expect(frame.metrics.find((item) => item.id === "healthy-targets")?.value).toBe(0);
  });

  it("flags flapping only when a second failure window can re-add targets", () => {
    const frame = runModel(model, params("flapping"), 20261110, 20);
    expect(frame.metrics.find((item) => item.id === "flap-index")?.value).toBe(100);
    expect(frame.events.filter((event) => event.id === "target-flapping")).toHaveLength(1);
    expect(frame.flags.flapping).toBe(1);

    const singleWindow = runModel(model, params("failure"), 20261110, 20);
    expect(singleWindow.metrics.find((item) => item.id === "flap-index")?.value).toBe(0);
    expect(singleWindow.events.filter((event) => event.id === "target-flapping")).toHaveLength(0);
  });

  it("calculates detection and recovery from the check settings", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.metrics.find((item) => item.id === "detection-seconds")?.value).toBe(15);
    expect(frame.metrics.find((item) => item.id === "recovery-seconds")?.value).toBe(100);
  });

  it("survives the same stall with a longer interval", () => {
    expect(valueOf("failure", "healthy-targets")).toBe(0);
    expect(valueOf("recovery", "healthy-targets")).toBe(6);
    expect(valueOf("recovery", "capacity-out")).toBe(0);
  });

  it("runs the experiment on the short-interval failure it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-blip-blast-radius");
    expect(experiment?.setup.intervalSeconds).toBe(5);
    expect(experiment?.setup.unhealthyThreshold).toBe(2);
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
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "flapping"]),
    );
    expect(module.interview.length).toBe(module.meta.interviewQuestions);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
