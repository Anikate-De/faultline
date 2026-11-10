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
import { albTargetGroupsModel, module } from "./module";

const model = albTargetGroupsModel;
const presets = module.sims["alb-target-groups"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 20) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("traffic-alb-target-groups model", () => {
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
    expect(frame.metrics.find((item) => item.id === "connection-failures")?.value).toBe(100);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("fires registration and unhealthy events once", () => {
    const frame = runModel(
      model,
      { ...params("failure"), registeredTargets: 0 },
      20261110,
      20,
    );
    expect(frame.events.filter((event) => event.id === "registration-change")).toHaveLength(1);
    expect(frame.flags.seed).toBe(20261110);
    expect(typeof frame.flags.paramsKey).toBe("string");

    const unhealthy = runModel(model, params("wrong-path"), 20261110, 20);
    expect(unhealthy.events.filter((event) => event.id === "all-targets-unhealthy")).toHaveLength(1);
    expect(unhealthy.flags.allUnhealthy).toBe(1);
  });

  it("separates an empty target group from unhealthy targets", () => {
    const empty = runModel(model, { ...params("healthy"), registeredTargets: 0 }, 20261110, 20);
    expect(empty.metrics.find((item) => item.id === "elb-503")?.value).toBe(100);
    expect(empty.metrics.find((item) => item.id === "unhealthy-share")?.value).toBe(0);
    expect(empty.metrics.find((item) => item.id === "target-utilization")?.value).toBe(0);

    const wrongPath = runModel(model, params("wrong-path"), 20261110, 20);
    expect(wrongPath.metrics.find((item) => item.id === "elb-503")?.value).toBe(0);
    expect(wrongPath.metrics.find((item) => item.id === "unhealthy-share")?.value).toBe(100);
  });

  it("shows fail-open traffic when all targets are unhealthy but reachable", () => {
    const frame = runModel(model, params("wrong-path"), 20261110, 20);
    expect(frame.metrics.find((item) => item.id === "connection-failures")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "served")?.value).toBeGreaterThan(0);
    expect(frame.metrics.find((item) => item.id === "healthy-targets")?.value).toBe(0);
  });

  it("caps served requests at registered target capacity", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), registeredTargets: 6, requestRate: 10_000 },
      20261110,
      20,
    );
    expect(frame.metrics.find((item) => item.id === "served")?.value).toBe(7_200);
    expect(frame.metrics.find((item) => item.id === "error-rate")?.value).toBeCloseTo(28, 6);
    expect(frame.metrics.find((item) => item.id === "p99")?.value).toBeGreaterThan(300);
    expect(frame.nodes.find((node) => node.id === "client")?.health).toBe("crit");
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("shows real connection failures when the security group blocks the ALB", () => {
    expect(valueOf("failure", "connection-failures")).toBe(100);
    expect(valueOf("failure", "served")).toBe(0);
  });

  it("runs the experiment on an empty target group", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-empty-target-group");
    expect(experiment?.setup.registeredTargets).toBe(0);
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
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.interview.length).toBe(module.meta.interviewQuestions);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
