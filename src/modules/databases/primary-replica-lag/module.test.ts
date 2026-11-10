import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, replicaLagModel } from "./module";

const model = replicaLagModel;
const presets = module.sims["primary-replica-lag"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("databases-primary-replica-lag model", () => {
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

  it("crosses a critical threshold within 60 simulated seconds in the replay-stall preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "apply-backlog")).toBeGreaterThan(256);
    expect(value(frame, "receive-gap")).toBe(0);
    expect(value(frame, "replication-time-lag")).toBeGreaterThan(5);
    expect(value(frame, "stale-read-rate")).toBeGreaterThan(500);
  });

  it("shows a transfer bottleneck with no apply backlog", () => {
    const frame = runModel(model, params("network-stall"), 20261110, 30);
    expect(value(frame, "receive-gap")).toBeGreaterThan(256);
    expect(value(frame, "apply-backlog")).toBe(0);
    expect(value(frame, "replication-time-lag")).toBeGreaterThan(5);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("shows replay headroom pressure without a growing backlog in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 30);
    expect(value(frame, "apply-backlog")).toBe(0);
    expect(value(frame, "apply-utilization")).toBeGreaterThan(95);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("drains the backlog with the experiment's fixed replay capacity", () => {
    let frame = initModel(model, params("failure"), 99);
    const rng = createRng(99);
    for (let index = 0; index < 100; index++) {
      frame = stepModel(model, frame, params("failure"), rng);
    }
    const fix = module.experiments[0].fix;
    if (!fix) throw new Error("Experiment fix missing");
    for (let index = 0; index < 300; index++) {
      frame = stepModel(model, frame, fix, rng);
    }
    expect(value(frame, "apply-backlog")).toBe(0);
    expect(value(frame, "replication-time-lag")).toBeLessThan(0.1);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "apply-backlog")).toBe(0);
    expect(value(frame, "replication-time-lag")).toBeLessThan(0.1);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-apply-backlog-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "threshold-replication-time-lag-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "wal-replay-behind").length).toBe(1);
  });

  it("grows the backlog over time while generation exceeds replay", () => {
    const ten = runModel(model, params("failure"), 1, 10);
    const twenty = runModel(model, params("failure"), 1, 20);
    expect(value(twenty, "apply-backlog")).toBeGreaterThan(value(ten, "apply-backlog"));
    expect(value(twenty, "replication-time-lag")).toBeGreaterThan(value(ten, "replication-time-lag"));
  });

  it("drains the backlog when replay capacity rises", () => {
    let frame = initModel(model, params("failure"), 99);
    const rng = createRng(99);
    for (let index = 0; index < 100; index++) {
      frame = stepModel(model, frame, params("failure"), rng);
    }
    expect(value(frame, "apply-backlog")).toBeGreaterThan(0);
    const recovered = params("recovery");
    for (let index = 0; index < 600; index++) {
      frame = stepModel(model, frame, recovered, rng);
    }
    expect(value(frame, "apply-backlog")).toBe(0);
    expect(value(frame, "replication-time-lag")).toBeLessThan(0.1);
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
      "network-stall",
      "recovery",
    ]);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
