import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { littlesLawModel, module } from "./module";

const model = littlesLawModel;
const presets = module.sims["littles-law"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("foundations-littles-law model", () => {
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

  it("crosses critical within 30 seconds when arrivals exceed capacity", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "queueDepth")).toBeGreaterThan(300);
    expect(value(frame, "throughput")).toBeLessThan(450);
  });

  it("returns to ok within 60 seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "utilization")).toBeLessThan(80);
  });

  it("warns without failing in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-queueDepth-crit");
    expect(critical.length).toBe(1);
    expect(frame.events.filter((event) => event.id === "queue-unbounded").length).toBe(1);
  });

  it("satisfies L = lambda times W", () => {
    for (const id of ["healthy", "peak", "failure"]) {
      const frame = runModel(model, params(id), 20261110, 20);
      const arrival = Number(params(id).arrivalRate);
      const latencySeconds = value(frame, "latency") / 1_000;
      expect(value(frame, "concurrency")).toBeCloseTo(arrival * latencySeconds, 3);
    }
  });

  it("keeps throughput flat when demand rises above capacity", () => {
    const healthy = runModel(model, params("healthy"), 20261110, 20);
    const failure = runModel(model, params("failure"), 20261110, 20);
    expect(value(failure, "throughput")).toBeCloseTo(value(healthy, "throughput"), 0);
    expect(value(failure, "throughput")).toBeCloseTo(400, 0);
    expect(value(failure, "queueDepth")).toBeGreaterThan(value(healthy, "queueDepth"));
  });

  it("distributes all workers across the visible pools", () => {
    const frame = runModel(model, { ...params("healthy"), workers: 31 }, 20261110, 1);
    const pools = frame.nodes.filter((node) => node.id.startsWith("workers-"));
    expect(pools.map((node) => node.sublabel)).toEqual(["11 workers", "10 workers", "10 workers"]);
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
    expect(model.params.length).toBe(3);
    expect(module.sims["littles-law"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
