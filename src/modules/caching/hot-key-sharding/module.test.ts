import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { hotKeyModel, module } from "./module";

const model = hotKeyModel;
const presets = module.sims["hot-key"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const maxShardCpu = (id: string, seconds = 20) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((m) => m.id === "hot-shard-cpu")?.value ?? 0;

describe("caching-hot-key-sharding model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative utilization", () => {
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

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((m) => m.id === "hot-shard-cpu")?.value).toBeGreaterThan(85);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-hot-shard-cpu-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("salting reduces the maximum shard CPU", () => {
    const base = maxShardCpu("failure");
    const salted = maxShardCpu("salting");
    expect(salted).toBeLessThan(base);
    expect(salted).toBeLessThan(75);
  });

  it("local caching reduces Redis load but increases staleness", () => {
    const base = runModel(model, params("failure"), 20261110, 20);
    const cached = runModel(model, params("local-cache"), 20261110, 20);
    const redisRps = (frame: typeof base) => frame.nodes.find((node) => node.id === "redis")?.throughput ?? 0;
    const staleness = (frame: typeof base) => frame.metrics.find((metric) => metric.id === "staleness")?.value ?? 0;
    expect(redisRps(cached)).toBeLessThan(redisRps(base));
    expect(staleness(cached)).toBeGreaterThan(staleness(base));
    expect(cached.metrics.find((metric) => metric.id === "hot-shard-cpu")?.value).toBeLessThan(
      base.metrics.find((metric) => metric.id === "hot-shard-cpu")?.value ?? 0,
    );
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
    expect(model.params.length).toBeGreaterThanOrEqual(4);
    expect(model.params.length).toBeLessThanOrEqual(6);
    expect(module.sims["hot-key"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
