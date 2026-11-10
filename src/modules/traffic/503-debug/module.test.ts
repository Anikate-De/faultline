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
import { module, serviceUnavailableModel } from "./module";

const model = serviceUnavailableModel;
const presets = module.sims["503-debug"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
describe("traffic-503-debug model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("overload"), 42, 30);
    const b = runModel(model, params("overload"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = runModel(model, params("healthy"), 20261110, 0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(frame.metrics.find((item) => item.id === "rate-503")?.value).toBe(0);
  });

  it("never reports NaN, Infinity, or negative metrics", () => {
    const frame = runModel(model, params("overload"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const node of frame.nodes) {
      expect(Number.isFinite(node.utilization ?? 0)).toBe(true);
      expect(node.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(node.utilization ?? 0).toBeLessThanOrEqual(1);
      expect(Number.isFinite(node.throughput ?? 0)).toBe(true);
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
    expect(frame.metrics.find((item) => item.id === "rate-503")?.value).toBe(100);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("shows an ELB-generated 503 with idle target CPU when nothing is registered", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.metrics.find((item) => item.id === "elb-503")?.value).toBe(3_000);
    expect(frame.metrics.find((item) => item.id === "target-503")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "target-cpu")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "registered-targets")?.value).toBe(0);
    expect(frame.nodes.filter((node) => node.id.startsWith("target-")).every((node) => node.health === "down")).toBe(
      true,
    );
  });

  it("shows target-generated 503s at moderate CPU with every target registered", () => {
    const frame = runModel(model, params("overload"), 20261110, 20);
    expect(frame.metrics.find((item) => item.id === "elb-503")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "target-503")?.value).toBe(3_000);
    expect(frame.metrics.find((item) => item.id === "registered-targets")?.value).toBe(3);
    expect(frame.metrics.find((item) => item.id === "target-cpu")?.value).toBeCloseTo(40, 0);
    expect(frame.metrics.find((item) => item.id === "rate-503")?.value).toBeCloseTo(33.33, 1);
    expect(frame.nodes.filter((node) => node.id.startsWith("target-")).every((node) => node.health === "crit")).toBe(
      true,
    );
  });

  it("keeps each source event to one occurrence while the condition persists", () => {
    const failure = runModel(model, params("failure"), 20261110, 30);
    expect(failure.events.filter((item) => item.id === "no-registered-target")).toHaveLength(1);
    expect(failure.events.filter((item) => item.id === "target-shedding")).toHaveLength(0);
    const overload = runModel(model, params("overload"), 20261110, 30);
    expect(overload.events.filter((item) => item.id === "target-shedding")).toHaveLength(1);
    expect(overload.events.filter((item) => item.id === "no-registered-target")).toHaveLength(0);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("overload"), 20261110, 20);
    const series = frame.series["rate-503"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("raising target concurrency clears target-generated 503s at the same traffic", () => {
    const fixed = runModel(model, { ...params("overload"), targetConcurrency: 500 }, 20261110, 20);
    expect(fixed.metrics.find((item) => item.id === "target-503")?.value).toBe(0);
    expect(fixed.metrics.find((item) => item.id === "target-load")?.value ?? 0).toBeLessThan(80);
    expect(fixed.metrics.find((item) => item.id === "target-cpu")?.value ?? 0).toBeLessThan(40);
  });

  it("runs the experiment at the overload setup it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "explain-503-at-low-cpu");
    expect(experiment?.setup.registeredTargets).toBe(3);
    expect(experiment?.setup.requestRate).toBe(9_000);
    const frame = runModel(model, experiment?.setup ?? {}, 20261110, experiment?.runFor ?? 20);
    expect(frame.metrics.find((item) => item.id === "target-503")?.value).toBeGreaterThan(0);
    expect(frame.metrics.find((item) => item.id === "elb-503")?.value).toBe(0);
    const fixed = runModel(model, experiment?.fix ?? {}, 20261110, 20);
    expect(fixed.metrics.find((item) => item.id === "target-503")?.value).toBe(0);
  });

  it("runFor matches stepping the same number of ticks", () => {
    const seconds = 12;
    const fast = runModel(model, params("overload"), 99, seconds);
    let stepped = initModel(model, params("overload"), 99);
    const rng = createRng(99);
    for (let index = 0; index < seconds / TICK; index++) {
      stepped = stepModel(model, stepped, params("overload"), rng);
    }
    expect(stepped.t).toBeCloseTo(fast.t, 5);
    for (const item of fast.metrics) {
      const other = stepped.metrics.find((entry) => entry.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(4);
    expect(presets).toHaveLength(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "overload"]),
    );
    expect(module.experiments).toHaveLength(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    expect(module.meta.tags).toEqual([
      "503",
      "no registered targets",
      "connection limit",
      "overload",
      "target",
    ]);
    expect(module.meta.learningDelta).toBe(
      "A 503 can be ELB-generated when no target is registered, or target-generated when a concurrency or pool limit rejects work; CPU alone does not explain it",
    );
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
