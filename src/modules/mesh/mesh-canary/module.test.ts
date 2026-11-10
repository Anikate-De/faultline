import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { meshCanaryModel, module } from "./module";

const model = meshCanaryModel;
const presets = module.sims["mesh-canary"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("mesh-canary model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy and never reports NaN, Infinity, or negative metrics", () => {
    const start = runModel(model, params("healthy"), 20261110, 0);
    expect(activeThreshold(start, model.thresholds)).toBeNull();
    expect(activeNodeIncident(start)).toBeNull();
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
      for (const item of values) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("passes the canary, then crosses critical within 60 seconds after promotion", () => {
    const canary = runModel(model, params("failure"), 20261110, 10);
    expect(activeThreshold(canary, model.thresholds)).toBeNull();
    expect(canary.flags.gate).toBe("pass");
    expect(canary.flags.phase).toBe("canary");
    const promoted = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(promoted, model.thresholds)?.severity).toBe("crit");
    expect(value(promoted, "pool-util")).toBeGreaterThan(95);
    expect(value(promoted, "v2-p99")).toBeGreaterThan(700);
    expect(promoted.flags.phase).toBe("promoted");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "pool-util")).toBeLessThan(60);
    expect(value(frame, "v2-error")).toBeLessThan(1);
  });

  it("warns without failing in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "v2-error")).toBeLessThan(5);
    expect(value(frame, "v2-p99")).toBeLessThan(700);
  });

  it("rejects an underpowered gate on sample count", () => {
    const frame = runModel(model, params("underpowered"), 20261110, 30);
    expect(frame.flags.gate).toBe("fail");
    expect(value(frame, "gate-shortfall")).toBe(17_000);
    expect(activeThreshold(frame, model.thresholds)?.threshold.id).toBe("gate-shortfall");
  });

  it("projects the capacity risk while the canary is still green", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    expect(value(frame, "projected-p99")).toBeGreaterThan(1_500);
    expect(value(frame, "v2-p99")).toBeLessThan(100);
  });

  it("moves the canary node into the full-rollout stage", () => {
    const before = runModel(model, params("failure"), 20261110, 10);
    const after = runModel(model, params("failure"), 20261110, 45);
    expect(before.nodes.find((node) => node.id === "v2")?.meta?.stage).toBe("canary");
    expect(after.nodes.find((node) => node.id === "v2")?.meta?.stage).toBe("full");
  });

  it("keeps promotion and capacity events to one occurrence", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "rollout-promoted")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "rollout-capacity-gap")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "rollout-canary-step")).toHaveLength(1);
  });

  it("runFor matches stepping the same number of ticks", () => {
    const seconds = 30;
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
    expect(model.params).toHaveLength(5);
    expect(presets).toHaveLength(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.experiments).toHaveLength(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    expect(module.meta.tags).toEqual(["canary", "metric gate", "sample size", "capacity", "rollback"]);
    expect(module.meta.learningDelta).toBe(
      "A canary needs a representative metric gate, enough traffic, and capacity headroom; low traffic hides tail failures",
    );
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
