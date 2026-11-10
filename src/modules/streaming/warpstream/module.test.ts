import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { warpStreamModel, module } from "./module";

const model = warpStreamModel;
const presets = module.sims.warpstream.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (id: string, metricId: string, seconds = 20) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("streaming-warpstream model", () => {
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
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("reaches critical within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue("failure", "p99-end-to-end", 30)).toBeGreaterThan(800);
    expect(metricValue("failure", "object-requests", 30)).toBeGreaterThan(10_000);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps one critical tail-latency event", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "object-tail-latency").length).toBe(1);
  });

  it("longer batches reduce requests and raise p99", () => {
    const shortBatch = params("healthy");
    const longBatch = { ...shortBatch, batchIntervalMs: 1_000 };
    const shortFrame = runModel(model, shortBatch, 20261110, 10);
    const longFrame = runModel(model, longBatch, 20261110, 10);
    const metric = (frame: typeof shortFrame, id: string) =>
      frame.metrics.find((item) => item.id === id)?.value ?? 0;
    expect(metric(longFrame, "object-requests")).toBeLessThan(metric(shortFrame, "object-requests"));
    expect(metric(longFrame, "p99-end-to-end")).toBeGreaterThan(metric(shortFrame, "p99-end-to-end"));
  });

  it("express storage lowers p99 at a higher cost", () => {
    const base = params("peak");
    const standard = runModel(model, { ...base, storageClass: 0 }, 20261110, 10);
    const express = runModel(model, { ...base, storageClass: 1 }, 20261110, 10);
    const metric = (frame: typeof standard, id: string) =>
      frame.metrics.find((item) => item.id === id)?.value ?? 0;
    expect(metric(express, "p99-end-to-end")).toBeLessThan(metric(standard, "p99-end-to-end"));
    expect(metric(express, "relative-cost")).toBeGreaterThan(metric(standard, "relative-cost"));
  });

  it("cost-optimized batching keeps requests low but breaches latency", () => {
    expect(metricValue("batch-optimized", "object-requests")).toBeLessThan(1_000);
    expect(metricValue("batch-optimized", "p99-end-to-end")).toBeGreaterThan(800);
  });

  it("healthy preset has no active threshold", () => {
    const frame = runModel(model, params("healthy"), 20261110, 20);
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
      const other = stepped.metrics.find((metricItem) => metricItem.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(4);
    expect(presets.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "batch-optimized"]),
    );
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
