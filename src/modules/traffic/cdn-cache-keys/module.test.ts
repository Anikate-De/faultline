import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { cdnCacheKeysModel, module } from "./module";

const model = cdnCacheKeysModel;
const presets = module.sims["cache-keys"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("traffic-cdn-cache-keys model", () => {
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

  it("loads the healthy preset with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metric(frame, "miss-rate")).toBeGreaterThan(40);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event and fires key-explosion once", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "threshold-miss-rate-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "key-explosion").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "identity-key-enabled").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["miss-rate"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("a full query string fragments more than a normalized one", () => {
    expect(metric(runModel(model, params("peak"), 20261110, 5), "key-count")).toBeGreaterThan(
      metric(runModel(model, params("healthy"), 20261110, 5), "key-count"),
    );
  });

  it("a per-user key collapses reuse compared with a normalized key", () => {
    const normalized = runModel(model, params("healthy"), 20261110, 5);
    const perUser = runModel(model, params("failure"), 20261110, 5);
    expect(metric(perUser, "miss-rate")).toBeGreaterThan(metric(normalized, "miss-rate") + 40);
    expect(metric(perUser, "origin-rps")).toBeGreaterThan(metric(normalized, "origin-rps") * 5);
    expect(metric(perUser, "wrong-content")).toBe(0);
  });

  it("ignoring the query protects hit rate but serves the wrong variant", () => {
    const frame = runModel(model, params("query-blind"), 20261110, 5);
    expect(metric(frame, "wrong-content")).toBeGreaterThan(2);
    expect(metric(frame, "hit-rate")).toBeGreaterThan(90);
  });

  it("scales wrong-content responses by the cache hit rate", () => {
    const warm = runModel(model, params("query-blind"), 20261110, 5);
    const cold = runModel(model, { ...params("query-blind"), userHeaderInKey: 1 }, 20261110, 5);
    expect(metric(cold, "wrong-content")).toBeLessThan(metric(warm, "wrong-content"));
    expect(metric(cold, "wrong-content")).toBeLessThan(1);
  });

  it("runs the experiment at the per-user setup it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-user-header");
    expect(experiment?.setup.userHeaderInKey).toBe(1);
    expect(experiment?.fix?.userHeaderInKey).toBe(0);
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
    expect(model.params.length).toBe(5);
    expect(module.sims["cache-keys"].alternateVisuals).toContain("timeline");
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.experiments.length).toBe(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
