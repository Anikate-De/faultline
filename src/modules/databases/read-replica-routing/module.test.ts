import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, routingModel } from "./module";

const model = routingModel;
const presets = module.sims["read-replica-routing"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("databases-read-replica-routing model", () => {
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

  it("routes read-after-write traffic to a stale replica without a sticky window", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(value(frame, "stale-read-share")).toBeCloseTo(18, 4);
    expect(value(frame, "stale-read-rate")).toBeCloseTo(720, 4);
    expect(value(frame, "writer-load")).toBeLessThan(70);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "stale-read-share")).toBe(0);
    expect(frame.nodes.filter((node) => node.health !== "ok")).toEqual([]);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-stale-read-share-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "read-after-write-stale").length).toBe(1);
  });

  it("removes staleness when the sticky window covers the lag", () => {
    const uncovered = runModel(model, { ...params("failure"), stickyWindowMs: 0 }, 1, 5);
    const covered = runModel(model, { ...params("failure"), stickyWindowMs: 8_000 }, 1, 5);
    expect(value(covered, "stale-read-share")).toBe(0);
    expect(value(covered, "stale-read-rate")).toBe(0);
    expect(value(covered, "writer-load")).toBeGreaterThan(value(uncovered, "writer-load"));
    expect(value(covered, "reader-load")).toBeLessThan(value(uncovered, "reader-load"));
  });

  it("does not divert reads to the primary when the replica has zero lag", () => {
    const sticky = runModel(model, { ...params("healthy"), replicaLagMs: 0, stickyWindowMs: 5_000 }, 1, 5);
    const plain = runModel(model, { ...params("healthy"), replicaLagMs: 0, stickyWindowMs: 0 }, 1, 5);
    expect(value(sticky, "writer-load")).toBeCloseTo(value(plain, "writer-load"), 6);
    expect(value(sticky, "reader-load")).toBeCloseTo(value(plain, "reader-load"), 6);
    expect(value(sticky, "stale-read-share")).toBe(0);
  });

  it("moves the cost to the writer when replicas are removed from the read path", () => {
    const replicas = runModel(model, params("healthy"), 1, 5);
    const primaryOnly = runModel(model, { ...params("healthy"), replicaReadShare: 0 }, 1, 5);
    expect(value(primaryOnly, "stale-read-share")).toBe(0);
    expect(value(primaryOnly, "writer-load")).toBeGreaterThan(value(replicas, "writer-load"));
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
    expect(model.params.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual([
      "healthy",
      "peak",
      "failure",
      "primary-only",
      "recovery",
    ]);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
