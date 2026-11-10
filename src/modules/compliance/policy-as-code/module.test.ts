import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, policyAsCodeModel } from "./module";

const model = policyAsCodeModel;
const presets = module.sims["policy-as-code"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("compliance-policy-as-code model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "control-floor")).toBe(100);
    expect(value(frame, "deploy-bypass")).toBe(0);
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
    expect(value(frame, "deploy-bypass")).toBeGreaterThanOrEqual(30);
    expect(value(frame, "policy-gap")).toBeGreaterThanOrEqual(40);
    expect(value(frame, "drift-gap")).toBeGreaterThanOrEqual(50);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const custom = frame.events.filter((event) => event.id === "noncompliant-resource");
    expect(custom.length).toBe(1);
    expect(custom[0].severity).toBe("crit");
  });

  it("does not treat a perfect deploy gate as drift detection", () => {
    const frame = runModel(
      model,
      { preDeployCoverage: 100, policyCoverage: 100, driftDetection: 0, exceptionHygiene: 100 },
      20261110,
      20,
    );
    expect(value(frame, "deploy-bypass")).toBe(0);
    expect(value(frame, "policy-gap")).toBe(0);
    expect(value(frame, "drift-gap")).toBe(100);
    expect(value(frame, "control-floor")).toBe(0);
    expect(frame.nodes.find((node) => node.id === "drift")?.health).toBe("crit");
  });

  it("derives the critical event from the largest control gap", () => {
    const bypass = runModel(model, params("failure"), 20261110, 20);
    const bypassEvent = bypass.events.find((event) => event.id === "noncompliant-resource");
    expect(bypassEvent?.metricId).toBe("deploy-bypass");
    expect(bypassEvent?.nodeId).toBe("pipeline");
    expect(bypassEvent?.title).toBe("A deploy path bypasses the policy gate");

    const exception = runModel(model, params("emergency-change"), 20261110, 20);
    const exceptionEvent = exception.events.find((event) => event.id === "noncompliant-resource");
    expect(exceptionEvent?.metricId).toBe("exception-gap");
    expect(exceptionEvent?.nodeId).toBe("evidence");
    expect(exceptionEvent?.title).toBe("An exception has no scope, owner, or expiry");
  });

  it("treats an unowned exception as a standing bypass", () => {
    const frame = runModel(model, params("emergency-change"), 20261110, 20);
    expect(value(frame, "deploy-bypass")).toBeGreaterThanOrEqual(30);
    expect(value(frame, "exception-gap")).toBe(80);
    expect(frame.nodes.find((node) => node.id === "cloud")?.health).toBe("crit");
  });

  it("restores the floor when drift detection covers the out-of-band path", () => {
    const frame = runModel(model, { ...module.experiments[0].fix }, 20261110, 20);
    expect(value(frame, "drift-gap")).toBe(0);
    expect(value(frame, "control-floor")).toBe(100);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
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
      const other = stepped.metrics.find((metricValue) => metricValue.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBeGreaterThanOrEqual(3);
    expect(model.params.length).toBeLessThanOrEqual(6);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(presets.length).toBe(5);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
