import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, readReplicasModel } from "./module";

const model = readReplicasModel;
const presets = module.sims["read-replicas"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;

describe("caching-read-replicas model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps the healthy preset calm at t=0", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.filter((node) => node.health !== "ok")).toEqual([]);
    const settled = runModel(model, params("healthy"), 20261110, 60);
    expect(activeThreshold(settled, model.thresholds)).toBeNull();
    expect(settled.nodes.filter((node) => node.health !== "ok")).toEqual([]);
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

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "replica-cpu")?.value).toBeGreaterThan(90);
    expect(frame.metrics.find((item) => item.id === "primary-cpu")?.value).toBeLessThan(75);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-replica-cpu-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("offloading reads lowers primary CPU", () => {
    const none = runModel(model, { ...params("healthy"), readSplit: 0 }, 1, 5);
    const half = runModel(model, { ...params("healthy"), readSplit: 50 }, 1, 5);
    const cpu = (frame: typeof none) => frame.metrics.find((item) => item.id === "primary-cpu")?.value ?? 0;
    expect(cpu(half)).toBeLessThan(cpu(none));
    expect(half.nodes.filter((node) => node.role === "replica").length).toBe(3);
  });

  it("lag rises when replicas saturate", () => {
    const healthy = runModel(model, params("healthy"), 1, 5);
    const failure = runModel(model, params("failure"), 1, 5);
    const lag = (frame: typeof healthy) => frame.metrics.find((item) => item.id === "replication-lag")?.value ?? 0;
    expect(lag(failure)).toBeGreaterThan(5);
    expect(lag(healthy)).toBeLessThan(1);
  });

  it("counts every offloaded read as stale once lag exceeds one second", () => {
    const healthy = runModel(model, params("healthy"), 1, 5);
    const failure = runModel(model, params("failure"), 1, 5);
    const stale = (frame: typeof healthy) => frame.metrics.find((item) => item.id === "stale-reads")?.value ?? 0;
    expect(stale(healthy)).toBe(0);
    expect(stale(failure)).toBeCloseTo(90, 5);
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
    expect(presets.map((item) => item.id)).toEqual(["healthy", "peak", "failure", "failover", "recovery"]);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
