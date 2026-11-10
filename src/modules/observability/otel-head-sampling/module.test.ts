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
import { headSamplingModel, module } from "./module";
import { meta } from "./meta";

const model = headSamplingModel;
const presets = module.sims["otel-head-sampling"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const sample = (id: string, seconds = 20) => runModel(model, params(id), 20261110, seconds);
const metricValue = (frame: ReturnType<typeof sample>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-otel-head-sampling model", () => {
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
      expect(Number.isFinite(node.throughput ?? 0)).toBe(true);
      expect(node.throughput ?? 0).toBeGreaterThanOrEqual(0);
    }
    for (const values of Object.values(frame.series)) {
      for (const point of values) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
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
    const frame = sample("failure", 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "blind-spot")).toBeGreaterThan(40);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = sample("recovery", 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = sample("failure", 60);
    const critical = frame.events.filter((event) => event.id === "threshold-blind-spot-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("loses rare-class visibility as the rate falls while cost falls too", () => {
    const healthy = sample("healthy");
    const low = sample("failure");
    expect(metricValue(low, "blind-spot")).toBeGreaterThan(metricValue(healthy, "blind-spot"));
    expect(metricValue(low, "stored-spans")).toBeLessThan(metricValue(healthy, "stored-spans"));
    expect(metricValue(low, "captured-errors")).toBeLessThan(metricValue(healthy, "captured-errors"));
  });

  it("raises the blind spot for a rarer class at the same rate", () => {
    const base = runModel(model, { ...params("healthy"), errorShare: 0.1 }, 20261110, 10);
    const rare = runModel(model, { ...params("healthy"), errorShare: 0.01 }, 20261110, 10);
    expect(metricValue(rare, "blind-spot")).toBeGreaterThan(metricValue(base, "blind-spot"));
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
    expect(meta.interviewQuestions).toBe(module.interview.length);
    expect(model.params.length).toBe(4);
    expect(presets.length).toBe(4);
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
