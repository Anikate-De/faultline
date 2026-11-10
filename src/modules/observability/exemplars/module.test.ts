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
import { exemplarsModel, module } from "./module";
import { meta } from "./meta";

const model = exemplarsModel;
const presets = module.sims.exemplars.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-exemplars model", () => {
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
    for (const bucket of frame.histogram?.buckets ?? []) {
      expect(Number.isFinite(bucket.count)).toBe(true);
      expect(bucket.count).toBeGreaterThanOrEqual(0);
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
    expect(metricValue(frame, "p99")).toBeGreaterThan(1_500);
    expect(metricValue(frame, "missing-exemplar")).toBeGreaterThan(60);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-p99-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("loses links as sampling falls without changing the p99", () => {
    const sampled = runModel(model, { ...params("healthy"), traceSample: 90 }, 20261110, 10);
    const sparse = runModel(model, { ...params("healthy"), traceSample: 1 }, 20261110, 10);
    expect(metricValue(sparse, "missing-exemplar")).toBeGreaterThan(
      metricValue(sampled, "missing-exemplar"),
    );
    expect(metricValue(sparse, "p99")).toBeCloseTo(metricValue(sampled, "p99"), 6);
  });

  it("builds a per-scrape histogram with one clickable slow exemplar", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    const histogram = frame.histogram;
    expect(histogram).toBeDefined();
    expect(histogram?.buckets.length).toBe(8);
    expect(histogram?.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(9_000);
    const dots = histogram?.buckets.filter((bucket) => bucket.exemplar) ?? [];
    expect(dots.length).toBe(1);
    expect(dots[0].label).toBe("1-2s");
    expect(dots[0].exemplar?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(dots[0].exemplar?.service).toBe("checkout-api");
    expect(dots[0].exemplar?.durationMs).toBe(1_400);
  });

  it("omits the exemplar dot when sampling makes it unlikely", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.histogram?.buckets.length).toBe(8);
    expect(frame.histogram?.buckets.some((bucket) => bucket.exemplar)).toBe(false);
  });

  it("gives the experiment setup a clickable exemplar dot", () => {
    const experiment = module.experiments[0];
    const frame = runModel(model, experiment.setup, 20261110, 10);
    const dots = frame.histogram?.buckets.filter((bucket) => bucket.exemplar) ?? [];
    expect(dots.length).toBe(1);
    expect(dots[0].exemplar?.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces fewer exemplars per minute with a longer scrape interval", () => {
    const fast = runModel(model, { ...params("healthy"), scrapeInterval: 5 }, 20261110, 10);
    const slow = runModel(model, { ...params("healthy"), scrapeInterval: 60 }, 20261110, 10);
    expect(metricValue(slow, "exemplar-links")).toBeLessThan(metricValue(fast, "exemplar-links"));
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
    expect(JSON.stringify(stepped.histogram)).toBe(JSON.stringify(fast.histogram));
  });

  it("declares the demo contract", () => {
    expect(meta.tags).toEqual(["exemplar", "trace ID", "histogram", "sampling", "correlation"]);
    expect(model.visual).toBe("histogram");
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
