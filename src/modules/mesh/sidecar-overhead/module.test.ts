import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, sidecarOverheadModel } from "./module";

const model = sidecarOverheadModel;
const presets = module.sims["mesh-sidecar-overhead"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("mesh-sidecar-overhead model", () => {
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

  it("crosses critical within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "cpu-util")).toBeGreaterThan(90);
    expect(value(frame, "throttled")).toBeGreaterThan(25);
    expect(value(frame, "p99")).toBeGreaterThan(500);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "throttled")).toBe(0);
  });

  it("warns without failing in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "cpu-util")).toBeGreaterThan(75);
    expect(value(frame, "throttled")).toBe(0);
    expect(value(frame, "p99")).toBeLessThan(150);
  });

  it("uses zero hops as the no-mesh baseline", () => {
    const frame = runModel(model, { ...params("healthy"), meshHops: 0 }, 20261110, 20);
    expect(value(frame, "p99")).toBeCloseTo(18, 0);
    expect(value(frame, "cpu-util")).toBe(0);
    expect(value(frame, "overhead")).toBeCloseTo(0, 0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("separates CPU throttling from pool queueing", () => {
    const cpuBound = runModel(model, { ...params("failure"), connectionPool: 512 }, 20261110, 20);
    const poolBound = runModel(
      model,
      { ...params("healthy"), requestRate: 20_000, meshHops: 1, cpuLimit: 1_000, connectionPool: 16 },
      20261110,
      20,
    );
    expect(value(cpuBound, "throttled")).toBeGreaterThan(25);
    expect(value(poolBound, "throttled")).toBe(0);
    expect(value(poolBound, "pool-util")).toBeGreaterThan(95);
    expect(activeThreshold(poolBound, model.thresholds)?.threshold.id).toBe("pool-util");
  });

  it("adds CPU demand with each hop", () => {
    const one = runModel(model, { ...params("healthy"), meshHops: 1 }, 20261110, 10);
    const three = runModel(model, { ...params("healthy"), meshHops: 3 }, 20261110, 10);
    expect(value(three, "cpu-util")).toBeGreaterThan(value(one, "cpu-util"));
    expect(value(three, "p99")).toBeGreaterThan(value(one, "p99"));
  });

  it("keeps the throttling event to one occurrence", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "sidecar-throttled")).toHaveLength(1);
  });

  it("runFor matches stepping the same number of ticks", () => {
    const seconds = 20;
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
    expect(model.params).toHaveLength(4);
    expect(presets).toHaveLength(4);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.experiments).toHaveLength(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    expect(module.meta.tags).toEqual(["sidecar", "hop", "CPU", "memory", "latency", "connection pool"]);
    expect(module.meta.learningDelta).toBe(
      "Sidecars add hops, CPU, memory, and connection pools; the cost is visible in per-hop latency and resource usage",
    );
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
