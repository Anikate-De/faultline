import { describe, expect, it } from "vitest";
import {
  activeNodeIncident,
  activeThreshold,
  initModel,
  runModel,
  stepModel,
  TICK,
} from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { coherenceModel, module } from "./module";

const model = coherenceModel;
const presets = module.sims.coherence.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("caching-coherence model", () => {
  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metric(frame, "stale-p99")).toBeLessThan(2);
  });

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

  it("crosses the critical staleness threshold within 30 simulated seconds", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metric(frame, "stale-p99")).toBeGreaterThan(10);
    expect(frame.events.some((event) => event.id === "threshold-stale-p99-crit")).toBe(true);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-stale-p99-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "coherence-missed-invalidation").length).toBe(1);
  });

  it("keeps the shared cache healthy while local copies are stale", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    const redis = frame.nodes.find((node) => node.id === "redis");
    expect(redis?.health).toBe("ok");
    expect(metric(frame, "stale-read-pct")).toBeGreaterThan(5);
  });

  it("versioned reads lower staleness and raise Redis operations", () => {
    const base = runModel(model, params("failure"), 20261110, 30);
    const versioned = runModel(model, params("recovery"), 20261110, 30);
    expect(metric(versioned, "stale-p99")).toBeLessThan(metric(base, "stale-p99"));
    expect(metric(versioned, "stale-read-pct")).toBeLessThan(metric(base, "stale-read-pct"));
    expect(metric(versioned, "redis-ops")).toBeGreaterThan(metric(base, "redis-ops"));
  });

  it("versioned reads are insensitive to invalidation delay", () => {
    const fast = runModel(model, { ...params("recovery"), invalidationDelayMs: 200 }, 20261110, 20);
    const slow = runModel(model, { ...params("recovery"), invalidationDelayMs: 3_000 }, 20261110, 20);
    expect(metric(slow, "stale-p99")).toBeCloseTo(metric(fast, "stale-p99"), 6);
    expect(metric(slow, "stale-read-pct")).toBeCloseTo(metric(fast, "stale-read-pct"), 6);
  });

  it("a durable bus lowers staleness without version lookups", () => {
    const versioned = runModel(model, params("recovery"), 20261110, 20);
    const durable = runModel(model, params("durable-bus"), 20261110, 20);
    expect(metric(durable, "stale-p99")).toBeLessThan(2);
    expect(metric(durable, "version-lookups")).toBeLessThan(metric(versioned, "version-lookups"));
    expect(metric(durable, "redis-ops")).toBeLessThan(metric(versioned, "redis-ops"));
  });

  it("a small loss below the p99 band does not reach the TTL", () => {
    const frame = runModel(model, { ...params("healthy"), pubsubLossPct: 0.5 }, 20261110, 20);
    expect(metric(frame, "stale-p99")).toBeLessThan(2);
    expect(metric(frame, "delivery-pct")).toBeGreaterThan(99);
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
      const other = stepped.metrics.find((entry) => entry.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(4);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
