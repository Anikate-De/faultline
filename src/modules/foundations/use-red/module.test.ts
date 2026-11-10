import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, useRedModel } from "./module";

const model = useRedModel;
const presets = module.sims["use-red"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("foundations-use-red model", () => {
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

  it("crosses the disk threshold within 30 seconds while RED stays healthy", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "disk-util")).toBeGreaterThan(90);
    expect(value(frame, "request-p99")).toBeLessThan(300);
    expect(value(frame, "error-rate")).toBeLessThan(1);
  });

  it("splits request throughput evenly across the three API tasks", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const tasks = frame.nodes.filter((node) => node.id.startsWith("app-"));
    expect(tasks).toHaveLength(3);
    for (const task of tasks) {
      expect(task.throughput).toBeCloseTo(4_000, 5);
    }
  });

  it("makes the p99 critical threshold reachable under extreme load", () => {
    const frame = runModel(
      model,
      { ...params("failure"), requestRate: 30_000, writeShare: 60, batchMbps: 600, cacheHit: 50 },
      20261110,
      20,
    );
    expect(value(frame, "request-p99")).toBeGreaterThan(450);
  });

  it("returns to ok within 60 seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "disk-util")).toBeLessThan(70);
  });

  it("warns without failing in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "disk-util")).toBeGreaterThan(70);
    expect(value(frame, "disk-util")).toBeLessThan(90);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-disk-util-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "disk-hidden").length).toBe(1);
  });

  it("raising the cache hit rate does not relieve a write-bound disk", () => {
    const failure = runModel(model, params("failure"), 20261110, 20);
    const cached = runModel(model, params("cache-raised"), 20261110, 20);
    expect(value(cached, "request-p99")).toBeLessThan(value(failure, "request-p99"));
    expect(value(cached, "disk-util")).toBeGreaterThan(90);
    expect(value(cached, "error-rate")).toBeLessThan(1);
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
    expect(module.sims["use-red"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
