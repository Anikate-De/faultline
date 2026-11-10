import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, topologyModel } from "./module";

const model = topologyModel;
const presets = module.sims["rds-aurora-arch"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("databases-rds-aurora-arch model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps the healthy preset calm at t=0", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.filter((node) => node.health !== "ok")).toEqual([]);
  });

  it("never reports NaN, Infinity, or out-of-range utilization", () => {
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

  it("saturates the writer when reads use the cluster endpoint", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(value(frame, "writer-utilization")).toBeGreaterThan(100);
    expect(value(frame, "reads-on-writer")).toBeCloseTo(2_280, 0);
    expect(value(frame, "reader-utilization")).toBeLessThan(10);
    expect(value(frame, "read-latency")).toBeGreaterThan(150);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.filter((node) => node.health !== "ok")).toEqual([]);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-writer-utilization-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "reads-on-writer").length).toBe(1);
  });

  it("moves load from writer to readers as routing rises", () => {
    const writerHeavy = runModel(model, { ...params("failure"), readRouting: 0 }, 1, 5);
    const readerHeavy = runModel(model, { ...params("failure"), readRouting: 100 }, 1, 5);
    expect(value(readerHeavy, "writer-utilization")).toBeLessThan(value(writerHeavy, "writer-utilization"));
    expect(value(readerHeavy, "reader-utilization")).toBeGreaterThan(value(writerHeavy, "reader-utilization"));
  });

  it("spreads the same read traffic across more replicas", () => {
    const two = runModel(model, { ...params("peak"), replicaCount: 2 }, 1, 5);
    const six = runModel(model, { ...params("peak"), replicaCount: 6 }, 1, 5);
    expect(value(six, "reader-utilization")).toBeCloseTo(value(two, "reader-utilization") / 3, 4);
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
