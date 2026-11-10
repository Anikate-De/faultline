import { describe, expect, it } from "vitest";
import {
  activeNodeIncident,
  activeThreshold,
  applyPresetFrame,
  initModel,
  runModel,
  stepModel,
  TICK,
} from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { keySaltingModel, module } from "./module";
import { meta } from "./meta";

const model = keySaltingModel;
const presets = module.sims["key-salting"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("caching-key-salting model", () => {
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

  it("loads the healthy preset with no active incident", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    const stepped = applyPresetFrame(model, preset("healthy"), 20261110);
    expect(activeThreshold(stepped, model.thresholds)).toBeNull();
    expect(activeNodeIncident(stepped)).toBeNull();
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "stale-reads")).toBeGreaterThan(50);
    expect(metricValue(frame, "hot-shard-cpu")).toBeLessThan(70);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "salted-writes-unsalted-reads");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("moves reads onto the salted path without stale reads", () => {
    const stale = runModel(model, params("failure"), 20261110, 20);
    const salted = runModel(model, params("recovery"), 20261110, 20);
    expect(metricValue(stale, "stale-reads")).toBeGreaterThan(90);
    expect(metricValue(salted, "stale-reads")).toBe(0);
    expect(metricValue(salted, "ops-per-read")).toBe(8);
    expect(metricValue(salted, "total-redis-ops")).toBeGreaterThan(metricValue(stale, "total-redis-ops"));
  });

  it("matches total Redis ops to the sum of shard throughput", () => {
    for (const id of ["healthy", "failure", "recovery"]) {
      const frame = runModel(model, params(id), 20261110, 20);
      const shardSum = frame.nodes
        .filter((node) => node.meta?.view === "shards")
        .reduce((sum, node) => sum + (node.throughput ?? 0), 0);
      expect(metricValue(frame, "total-redis-ops")).toBeCloseTo(shardSum, 0);
    }
  });

  it("shows dual-write recreating the old write hot spot", () => {
    const salted = runModel(model, params("recovery"), 20261110, 20);
    const dual = runModel(model, params("dual-write"), 20261110, 20);
    expect(metricValue(dual, "hot-shard-cpu")).toBeGreaterThan(metricValue(salted, "hot-shard-cpu"));
    expect(metricValue(dual, "stale-reads")).toBe(0);
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
      expect(stepped.metrics.find((other) => other.id === item.id)?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(meta.tags).toEqual(["key salting", "fan-out", "deterministic hash", "migration", "consistency"]);
    expect(model.params.length).toBe(4);
    expect(presets.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
