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
import { cachePenetrationModel, module } from "./module";

const model = cachePenetrationModel;
const sim = module.sims["cache-penetration"];
const preset = (id: string) => {
  const found = sim.presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("caching-cache-penetration model", () => {
  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metric(frame, "db-qps")).toBeLessThan(1_000);
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

  it("crosses the critical database threshold within 30 simulated seconds", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metric(frame, "db-qps")).toBeGreaterThan(8_000);
    expect(frame.events.some((event) => event.id === "threshold-db-qps-crit")).toBe(true);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-db-qps-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "penetration-wave").length).toBe(1);
  });

  it("a Bloom filter removes most absent traffic but not all of it", () => {
    const unfiltered = runModel(model, params("failure"), 20261110, 20);
    const filtered = runModel(model, params("bloom-only"), 20261110, 20);
    expect(metric(filtered, "absent-db-rps")).toBeLessThan(metric(unfiltered, "absent-db-rps") / 10);
    expect(metric(filtered, "absent-db-rps")).toBeGreaterThan(0);
    expect(metric(filtered, "bloom-fpr")).toBeLessThan(1);
  });

  it("a larger Bloom filter lowers false positives and database load", () => {
    const small = runModel(model, { ...params("bloom-only"), bloomBitsPerKey: 4 }, 20261110, 20);
    const large = runModel(model, { ...params("bloom-only"), bloomBitsPerKey: 12 }, 20261110, 20);
    expect(metric(large, "bloom-fpr")).toBeLessThan(metric(small, "bloom-fpr"));
    expect(metric(large, "db-qps")).toBeLessThan(metric(small, "db-qps"));
  });

  it("a negative cache alone helps repeated absent keys", () => {
    const noCache = runModel(model, { ...params("bloom-only"), negativeCacheHitPct: 0 }, 20261110, 20);
    const cached = runModel(model, { ...params("bloom-only"), negativeCacheHitPct: 90 }, 20261110, 20);
    expect(metric(cached, "absent-db-rps")).toBeLessThan(metric(noCache, "absent-db-rps") / 5);
  });

  it("uses the standard Bloom false-positive formula", () => {
    const eight = runModel(model, { ...params("healthy"), bloomBitsPerKey: 8 }, 20261110, 5);
    const sixteen = runModel(model, { ...params("healthy"), bloomBitsPerKey: 16 }, 20261110, 5);
    expect(metric(eight, "bloom-fpr")).toBeGreaterThan(1.5);
    expect(metric(eight, "bloom-fpr")).toBeLessThan(3);
    expect(metric(sixteen, "bloom-fpr")).toBeLessThan(0.1);
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
    expect(sim.presets.map((item) => item.id)).toEqual(
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
