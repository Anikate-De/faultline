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
import { module, profilingModel } from "./module";
import { meta } from "./meta";

const model = profilingModel;
const presets = module.sims["continuous-profiling"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-continuous-profiling model", () => {
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
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "service-cpu")).toBeGreaterThan(90);
    expect(metricValue(frame, "hot-function-share")).toBeGreaterThan(35);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-service-cpu-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("attributes the new release to serialization and allocation", () => {
    const before = runModel(model, { ...params("healthy"), release: 1 }, 20261110, 10);
    const after = runModel(model, { ...params("healthy"), release: 2, payloadKb: 40 }, 20261110, 10);
    expect(metricValue(after, "cpu-per-request")).toBeGreaterThan(
      metricValue(before, "cpu-per-request"),
    );
    expect(metricValue(after, "hot-function-share")).toBeGreaterThan(
      metricValue(before, "hot-function-share"),
    );
  });

  it("raises CPU with traffic without making one function hotter", () => {
    const low = runModel(model, { ...params("healthy"), traffic: 1_000 }, 20261110, 10);
    const high = runModel(model, { ...params("healthy"), traffic: 4_000 }, 20261110, 10);
    expect(metricValue(high, "service-cpu")).toBeGreaterThan(metricValue(low, "service-cpu"));
    expect(metricValue(high, "hot-function-share")).toBeCloseTo(
      metricValue(low, "hot-function-share"),
      3,
    );
  });

  it("raises profiler overhead with the sample rate", () => {
    const low = runModel(model, { ...params("healthy"), sampleHz: 10 }, 20261110, 10);
    const high = runModel(model, { ...params("healthy"), sampleHz: 100 }, 20261110, 10);
    expect(metricValue(high, "profiler-overhead")).toBeGreaterThan(
      metricValue(low, "profiler-overhead"),
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
    for (const item of fast.metrics) {
      expect(stepped.metrics.find((other) => other.id === item.id)?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(meta.tags).toEqual(["profiling", "flame graph", "sample", "CPU", "allocation", "self time"]);
    expect(model.params.length).toBe(4);
    expect(presets.length).toBe(4);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
