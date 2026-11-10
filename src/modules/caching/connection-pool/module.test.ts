import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, poolModel } from "./module";

const model = poolModel;
const presets = module.sims.pool.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("caching-connection-pool model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("never reports NaN, Infinity, or out-of-range values", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const node of frame.nodes) {
      expect(Number.isFinite(node.utilization ?? 0)).toBe(true);
      expect(node.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(node.utilization ?? 0).toBeLessThanOrEqual(1);
      expect(Number.isFinite(node.throughput ?? 0)).toBe(true);
      expect(node.throughput ?? 0).toBeGreaterThanOrEqual(0);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses warning and critical within 30 simulated seconds", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "pool-wait")).toBeGreaterThan(50);
    expect(frame.events.some((event) => event.id === "threshold-pool-wait-crit")).toBe(true);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-pool-wait-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("fires the pool wait event once", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "pool-wait-detected").length).toBe(1);
    expect(frame.flags.poolWaitSeen).toBe(1);
  });

  it("keeps Redis idle while the pool queues", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(metricValue(frame, "redis-cpu")).toBeLessThan(75);
    expect(metricValue(frame, "pool-wait")).toBeGreaterThan(500);
    expect(metricValue(frame, "queueDepth")).toBeGreaterThan(
      Number(params("failure").requestRps),
    );
  });

  it("passes arrival rate to the queue node, not queue depth", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const queue = frame.nodes.find((node) => node.kind === "queue");
    const requestRps = Number(params("failure").requestRps);
    expect(queue).toBeDefined();
    expect(Math.abs((queue?.throughput ?? 0) - requestRps)).toBeLessThan(requestRps * 0.01);
    expect(metricValue(frame, "queueDepth")).toBeGreaterThan(Number(queue?.throughput ?? 0));
  });

  it("shows fleet command rate on the Redis node, not the per-instance rate", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const redis = frame.nodes.find((node) => node.id === "redis");
    const expected = Number(params("failure").requestRps) * Number(params("failure").instances);
    expect(redis?.throughput).toBeGreaterThan(expected * 0.99);
    expect(redis?.throughput).toBeLessThan(expected * 1.01);
  });

  it("re-fires the pool wait event after recovery and a later failure", () => {
    let frame = initModel(model, params("failure"), 20261110);
    const rng = createRng(20261110);
    for (let index = 0; index < 100; index++) {
      frame = stepModel(model, frame, params("failure"), rng);
    }
    expect(frame.events.filter((event) => event.id === "pool-wait-detected").length).toBe(1);
    for (let index = 0; index < 100; index++) {
      frame = stepModel(model, frame, params("recovery"), rng);
    }
    expect(frame.flags.poolWaitSeen).toBe(0);
    for (let index = 0; index < 100; index++) {
      frame = stepModel(model, frame, params("failure"), rng);
    }
    expect(frame.events.filter((event) => event.id === "pool-wait-detected").length).toBe(2);
  });

  it("shows the fleet-wide cost of oversized pools", () => {
    const frame = runModel(model, params("oversize"), 20261110, 20);
    expect(metricValue(frame, "connections")).toBeGreaterThan(10_000);
    expect(metricValue(frame, "connection-rejects")).toBeGreaterThan(0);
    expect(metricValue(frame, "pool-wait")).toBeLessThan(5);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
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
    for (const metric of fast.metrics) {
      const other = stepped.metrics.find((item) => item.id === metric.id);
      expect(other?.value).toBeCloseTo(metric.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(4);
    expect(module.sims.pool.presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
