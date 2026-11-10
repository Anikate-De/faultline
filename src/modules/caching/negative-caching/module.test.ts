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
import { module, negativeCachingModel } from "./module";

const model = negativeCachingModel;
const sim = module.sims["negative-caching"];
const preset = (id: string) => {
  const found = sim.presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("caching-negative-caching model", () => {
  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metric(frame, "new-key-reject")).toBeLessThan(0.5);
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

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metric(frame, "db-qps")).toBeGreaterThan(8_000);
    expect(metric(frame, "new-key-reject")).toBeGreaterThan(2);
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
    expect(frame.events.filter((event) => event.id === "negative-cache-stale-create").length).toBe(1);
  });

  it("a longer negative TTL adds memory and rejection without more hits", () => {
    const short = runModel(model, { ...params("healthy"), negativeTtlSeconds: 10 }, 20261110, 20);
    const long = runModel(model, { ...params("healthy"), negativeTtlSeconds: 300 }, 20261110, 20);
    expect(metric(long, "negative-hit")).toBeCloseTo(metric(short, "negative-hit"), 6);
    expect(metric(long, "total-memory")).toBeGreaterThan(metric(short, "total-memory") * 10);
    expect(metric(long, "new-key-reject")).toBeGreaterThan(metric(short, "new-key-reject") * 10);
  });

  it("a larger Bloom filter lowers false positives and database load", () => {
    const small = runModel(model, { ...params("healthy"), bloomBitsPerKey: 4 }, 20261110, 20);
    const large = runModel(model, { ...params("healthy"), bloomBitsPerKey: 12 }, 20261110, 20);
    expect(metric(large, "bloom-fpr")).toBeLessThan(metric(small, "bloom-fpr"));
    expect(metric(large, "db-qps")).toBeLessThan(metric(small, "db-qps"));
  });

  it("a shorter TTL protects new keys but gives up negative hits", () => {
    const short = runModel(model, { ...params("short-ttl"), negativeTtlSeconds: 5 }, 20261110, 20);
    const long = runModel(model, { ...params("short-ttl"), negativeTtlSeconds: 30 }, 20261110, 20);
    expect(metric(short, "new-key-reject")).toBeLessThan(metric(long, "new-key-reject"));
    expect(metric(short, "negative-hit")).toBeLessThan(metric(long, "negative-hit"));
    expect(metric(short, "db-qps")).toBeGreaterThan(metric(long, "db-qps"));
  });

  it("a large filter lowers false positives without changing the negative TTL", () => {
    const frame = runModel(model, { ...params("healthy"), bloomBitsPerKey: 16 }, 20261110, 5);
    expect(metric(frame, "new-key-reject")).toBeLessThan(0.5);
    expect(metric(frame, "bloom-fpr")).toBeLessThan(0.1);
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
