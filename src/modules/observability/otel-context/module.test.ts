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
import { module, otelContextModel } from "./module";
import { meta } from "./meta";

const model = otelContextModel;
const presets = module.sims["otel-context"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (id: string) => {
  const frame = runModel(model, params(id), 20261110, 20);
  return (metricId: string) => frame.metrics.find((item) => item.id === metricId)?.value ?? 0;
};

describe("observability-otel-context model", () => {
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
    expect(frame.metrics.find((item) => item.id === "fragmentation")?.value).toBeGreaterThan(25);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-fragmentation-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("splits one checkout into more traces when the queue loses context", () => {
    const healthy = value("healthy");
    const broken = value("failure");
    expect(broken("trace-pieces")).toBeGreaterThan(healthy("trace-pieces"));
    expect(broken("orphan-roots")).toBeGreaterThan(healthy("orphan-roots"));
    expect(broken("checkout-p99")).toBeCloseTo(healthy("checkout-p99"), 0);
  });

  it("flags baggage growth independently of trace continuity", () => {
    const frame = runModel(model, { ...params("healthy"), baggageEntries: 30 }, 20261110, 10);
    expect(frame.metrics.find((item) => item.id === "baggage-bytes")?.value).toBe(2_400);
    expect(activeThreshold(frame, model.thresholds)?.threshold.id).toBe("baggage-bytes");
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
    expect(meta.tags).toEqual(["context propagation", "traceparent", "baggage", "async", "instrumentation"]);
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
