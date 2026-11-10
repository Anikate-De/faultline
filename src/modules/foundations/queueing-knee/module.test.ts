import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, queueingKneeModel } from "./module";

const model = queueingKneeModel;
const presets = module.sims["queueing-knee"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("foundations-queueing-knee model", () => {
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
      for (const item of values) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses critical within 30 seconds in the bursty failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "p99")).toBeGreaterThan(1_000);
    expect(value(frame, "utilization")).toBeLessThan(85);
  });

  it("returns to ok within 60 seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "p99")).toBeLessThan(250);
  });

  it("warns without failing in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "utilization")).toBeCloseTo(80, 0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-p99-crit");
    expect(critical.length).toBe(1);
    expect(frame.events.filter((event) => event.id === "knee-crossed").length).toBe(1);
  });

  it("variability changes the knee without changing utilization", () => {
    const calm = runModel(model, params("peak"), 20261110, 20);
    const bursty = runModel(model, params("failure"), 20261110, 20);
    expect(value(calm, "utilization")).toBeCloseTo(value(bursty, "utilization"), 5);
    expect(value(bursty, "p99")).toBeGreaterThan(value(calm, "p99") * 2);
    expect(value(bursty, "queueDepth")).toBeGreaterThan(value(calm, "queueDepth"));
  });

  it("adding capacity lowers p99 at the same arrival rate", () => {
    const failure = runModel(model, params("failure"), 20261110, 20);
    const recovery = runModel(model, params("recovery"), 20261110, 20);
    expect(value(recovery, "p99")).toBeLessThan(value(failure, "p99"));
    expect(value(recovery, "utilization")).toBeLessThan(value(failure, "utilization"));
  });

  it("keeps p99 monotonic from 90% through 99.9% utilization", () => {
    const capacity = (30 * 1_000) / 20;
    const points = Array.from({ length: 100 }, (_, index) => 0.9 + index * 0.001);
    const p99s = points.map((rho) =>
      value(
        runModel(model, { ...params("failure"), arrivalRate: capacity * rho }, 20261110, 0.5),
        "p99",
      ),
    );
    for (let index = 1; index < p99s.length; index++) {
      expect(p99s[index]).toBeGreaterThanOrEqual(p99s[index - 1] - 1e-6);
    }
    expect(p99s[p99s.length - 1]).toBeGreaterThan(p99s[0]);
  });

  it("distributes all servers across the visible pools", () => {
    const frame = runModel(model, { ...params("healthy"), servers: 31 }, 20261110, 1);
    const pools = frame.nodes.filter((node) => node.id.startsWith("server-"));
    expect(pools.map((node) => node.sublabel)).toEqual(["11 servers", "10 servers", "10 servers"]);
    const total = pools.reduce((sum, node) => sum + Number(node.sublabel?.split(" ")[0] ?? 0), 0);
    expect(total).toBe(31);
    expect(pools.reduce((sum, node) => sum + (node.throughput ?? 0), 0)).toBeCloseTo(1_550, 5);
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
    expect(model.params.length).toBe(4);
    expect(module.sims["queueing-knee"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
