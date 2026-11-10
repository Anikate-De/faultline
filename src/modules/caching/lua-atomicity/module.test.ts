import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { luaModel, module } from "./module";

const model = luaModel;
const presets = module.sims.lua.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("caching-lua-atomicity model", () => {
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

  it("separates Lua occupancy from total command-thread load", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(metricValue(frame, "script-busy")).toBeCloseTo(25, 1);
    expect(frame.nodes.find((node) => node.id === "redis")?.utilization).toBeCloseTo(0.25, 2);
  });

  it("does not add script duration to p99 when Lua coverage is zero", () => {
    const base = { ...params("healthy"), writeRps: 4_000, shardCount: 4, luaShare: 0 };
    const short = runModel(model, { ...base, scriptMs: 1 }, 20261110, 20);
    const long = runModel(model, { ...base, scriptMs: 100 }, 20261110, 20);
    expect(metricValue(short, "script-busy")).toBe(0);
    expect(metricValue(long, "script-busy")).toBe(0);
    expect(metricValue(long, "redis-p99")).toBeCloseTo(metricValue(short, "redis-p99"), 6);
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
    expect(metricValue(frame, "redis-p99")).toBeGreaterThan(100);
    expect(frame.events.some((event) => event.id === "threshold-redis-p99-crit")).toBe(true);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-redis-p99-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("fires the script stall event once", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "script-stall").length).toBe(1);
    expect(frame.flags.scriptStallSeen).toBe(1);
  });

  it("shows the correctness failure when Lua coverage is zero", () => {
    const setup = { ...params("healthy"), writeRps: 4_000, shardCount: 4, luaShare: 0 };
    const frame = runModel(model, setup, 20261110, 20);
    expect(metricValue(frame, "lost-updates")).toBeGreaterThanOrEqual(1);
    expect(metricValue(frame, "redis-p99")).toBeLessThan(20);
    expect(frame.events.some((event) => event.id === "lost-update-detected")).toBe(true);
  });

  it("a shorter script fixes the race without a stall", () => {
    const fixed = runModel(
      model,
      { ...params("healthy"), writeRps: 4_000, shardCount: 4, luaShare: 100, scriptMs: 0.5 },
      20261110,
      20,
    );
    expect(metricValue(fixed, "lost-updates")).toBe(0);
    expect(metricValue(fixed, "redis-p99")).toBeLessThan(20);
    expect(activeThreshold(fixed, model.thresholds)).toBeNull();
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
    expect(module.sims.lua.presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
