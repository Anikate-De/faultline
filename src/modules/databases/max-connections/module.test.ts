import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { connectionModel, module } from "./module";

const model = connectionModel;
const presets = module.sims["max-connections"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const node = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.nodes.find((item) => item.id === id);

describe("databases-max-connections model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps the healthy preset calm at t=0", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.filter((item) => item.health !== "ok")).toEqual([]);
  });

  it("never reports NaN, Infinity, or out-of-range utilization", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const item of frame.nodes) {
      expect(Number.isFinite(item.utilization ?? 0)).toBe(true);
      expect(item.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(item.utilization ?? 0).toBeLessThanOrEqual(1);
    }
    for (const values of Object.values(frame.series)) {
      for (const item of values) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("refuses connections when memory is the binding limit", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(value(frame, "practical-limit")).toBeLessThan(500);
    expect(value(frame, "practical-limit")).toBeGreaterThan(300);
    expect(value(frame, "refusal-rate")).toBeGreaterThan(5);
    expect(value(frame, "memory-utilization")).toBeGreaterThan(92);
    expect(value(frame, "connection-utilization")).toBeLessThan(70);
    expect(value(frame, "queueDepth")).toBeGreaterThan(0);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("keeps the queue node consistent with the queue depth metric", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(node(frame, "queue")?.kind).toBe("queue");
    expect(node(frame, "queue")?.meta?.depth).toBe(value(frame, "queueDepth"));
    expect(node(frame, "queue")?.throughput).toBeUndefined();
    expect(value(frame, "queueDepth")).toBeGreaterThan(0);
    expect(value(frame, "queueDepth")).toBe(
      Number(params("failure").attemptedConnections) - value(frame, "practical-limit"),
    );
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "refusal-rate")).toBe(0);
    expect(value(frame, "memory-utilization")).toBeLessThan(80);
    expect(frame.nodes.filter((item) => item.health !== "ok")).toEqual([]);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-memory-utilization-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "refused-before-max").length).toBe(1);
  });

  it("raises the practical limit with memory and lowers it with per-session memory", () => {
    const base = runModel(model, params("failure"), 1, 5);
    const moreMemory = runModel(model, { ...params("failure"), instanceMemoryGb: 8 }, 1, 5);
    const morePerConnection = runModel(model, { ...params("failure"), memoryPerConnectionMb: 16 }, 1, 5);
    expect(value(moreMemory, "practical-limit")).toBeGreaterThan(value(base, "practical-limit"));
    expect(value(morePerConnection, "practical-limit")).toBeLessThan(value(base, "practical-limit"));
    expect(value(moreMemory, "refusal-rate")).toBeLessThan(value(base, "refusal-rate"));
  });

  it("reserves three superuser slots below max_connections", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), attemptedConnections: 500, instanceMemoryGb: 16, memoryPerConnectionMb: 4 },
      1,
      5,
    );
    expect(value(frame, "practical-limit")).toBe(497);
    expect(value(frame, "queueDepth")).toBe(3);
    expect(value(frame, "connection-utilization")).toBeGreaterThan(95);
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
    expect(presets.map((item) => item.id)).toEqual(["healthy", "peak", "failure", "recovery"]);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
