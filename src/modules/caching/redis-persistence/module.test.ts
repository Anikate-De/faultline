import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, redisPersistenceModel } from "./module";

const model = redisPersistenceModel;
const presets = module.sims["redis-persistence"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;

describe("caching-redis-persistence model", () => {
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
    expect(frame.metrics.find((item) => item.id === "lost-writes")?.value).toBeGreaterThan(1_000_000);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-lost-writes-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("AOF everysec bounds the loss window to about one second", () => {
    const rdb = runModel(model, params("failure"), 20261110, 5);
    const aof = runModel(model, { ...params("failure"), persistence: 2 }, 20261110, 5);
    const window = (frame: typeof rdb) => frame.metrics.find((item) => item.id === "loss-window")?.value ?? 0;
    expect(window(rdb)).toBeGreaterThan(100);
    expect(window(aof)).toBe(1);
    expect(aof.metrics.find((item) => item.id === "lost-writes")?.value).toBeLessThan(
      rdb.metrics.find((item) => item.id === "lost-writes")?.value ?? 0,
    );
  });

  it("AOF always removes the loss window but raises write latency", () => {
    const everysec = runModel(model, { ...params("healthy"), writeRps: 30_000 }, 1, 5);
    const always = runModel(model, { ...params("healthy"), writeRps: 30_000, persistence: 3 }, 1, 5);
    const value = (frame: typeof everysec, id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    expect(value(always, "lost-writes")).toBe(0);
    expect(value(always, "write-p99")).toBeGreaterThan(value(everysec, "write-p99"));
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
    expect(presets.map((item) => item.id)).toEqual(["healthy", "peak", "failure", "aof-always", "recovery"]);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
