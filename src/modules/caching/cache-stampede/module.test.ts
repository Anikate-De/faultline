import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { cacheStampedeModel, module } from "./module";

const model = cacheStampedeModel;
const presets = module.sims["cache-stampede"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const maxMetric = (id: string, metricId: string, seconds = 20) => {
  let frame = initModel(model, params(id), 20261110);
  const rng = createRng(20261110);
  let max = 0;
  for (let index = 0; index < seconds / TICK; index++) {
    frame = stepModel(model, frame, params(id), rng);
    max = Math.max(max, metric(frame, metricId));
  }
  return max;
};

describe("caching-cache-stampede model", () => {
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
    expect(maxMetric("failure", "db-qps", 30)).toBeGreaterThan(6_000);
    expect(frame.events.some((event) => event.id === "threshold-db-qps-crit")).toBe(true);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps local cache health ok through a normal expiry", () => {
    const frame = runModel(model, params("failure"), 20261110, 5.1);
    const cache = frame.nodes.find((node) => node.id === "cache");
    expect(cache?.health).toBe("ok");
    expect(cache?.sublabel).toContain("expired");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 8);
    const critical = frame.events.filter((event) => event.id === "threshold-db-qps-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "stampede-wave").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["db-qps"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("single-flight reduces duplicate queries per TTL", () => {
    const base = runModel(model, params("failure"), 20261110, 20);
    const fixed = runModel(model, params("single-flight"), 20261110, 20);
    expect(metric(fixed, "miss-burst")).toBeLessThan(metric(base, "miss-burst") / 10);
  });

  it("jitter lowers the peak while total duplicate work stays unchanged", () => {
    const base = runModel(model, params("failure"), 20261110, 20);
    const jittered = runModel(model, params("jitter"), 20261110, 20);
    expect(maxMetric("jitter", "db-qps", 20)).toBeLessThan(maxMetric("failure", "db-qps", 20) / 5);
    expect(metric(jittered, "miss-burst")).toBeCloseTo(metric(base, "miss-burst"), 6);
    expect(metric(jittered, "expiry-events")).toBeCloseTo(metric(base, "expiry-events"), 6);
  });

  it("early refresh removes the expiry wave", () => {
    const refreshed = runModel(model, { ...params("failure"), earlyRefresh: 100 }, 20261110, 20);
    expect(metric(refreshed, "miss-burst")).toBeLessThan(1);
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
    expect(model.params.length).toBeGreaterThanOrEqual(4);
    expect(model.params.length).toBeLessThanOrEqual(6);
    expect(module.sims["cache-stampede"].alternateVisuals).toContain("queue");
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
