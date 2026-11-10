import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { backpressureModel, module } from "./module";

const model = backpressureModel;
const presets = module.sims["streaming-backpressure"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (id: string, seconds: number, presetId: string) =>
  runModel(model, params(presetId), 20261110, seconds).metrics.find((item) => item.id === id)?.value ?? 0;

describe("streaming-backpressure model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 40);
    const b = runModel(model, params("failure"), 42, 40);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold", () => {
    const frame = runModel(model, params("healthy"), 20261110, 0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    for (const node of frame.nodes) expect(node.health).toBe("ok");
  });

  it("never reports NaN, Infinity, or negative values", () => {
    const frame = runModel(model, params("failure"), 7, 90);
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

  it("crosses critical within 60 seconds on the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 25);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "buffer-fill")?.value).toBeCloseTo(100, 1);
    expect(frame.metrics.find((item) => item.id === "ingress-rejected")?.value).toBeGreaterThan(1_000);
  });

  it("returns to ok within 60 seconds on the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.metrics.find((item) => item.id === "buffer-fill")?.value).toBeLessThan(40);
  });

  it("warns at peak without overflowing the buffer", () => {
    const frame = runModel(model, params("peak"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(frame.metrics.find((item) => item.id === "buffer-fill")?.value).toBeGreaterThan(40);
    expect(frame.metrics.find((item) => item.id === "ingress-rejected")?.value).toBe(0);
  });

  it("caps queue depth at the buffer limit and rejects the excess", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const depth = frame.metrics.find((item) => item.id === "queueDepth")?.value ?? 0;
    const rejected = frame.metrics.find((item) => item.id === "ingress-rejected")?.value ?? 0;
    expect(depth).toBeLessThanOrEqual(250_000);
    expect(depth).toBeGreaterThan(249_000);
    expect(rejected).toBeGreaterThan(10_000);
  });

  it("scaling consumers drains the buffer without throttling", () => {
    expect(metricValue("buffer-fill", 40, "scale")).toBeLessThan(1);
    expect(metricValue("ingress-rejected", 40, "scale")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-buffer-fill-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "buffer-full-rejects").length).toBe(1);
  });

  it("preserves flags across steps", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.flags.seed).toBe(20261110);
    expect(frame.flags.rejectsStarted).toBe(1);
    expect(frame.flags.bufferWarning).toBe(1);
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
      const other = stepped.metrics.find((metric) => metric.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("caps consumer parallelism at the modeled partition count", () => {
    const ten = runModel(
      model,
      { ...params("failure"), produceRate: 35_000, consumers: 10 },
      20261110,
      20,
    );
    const twelve = runModel(
      model,
      { ...params("failure"), produceRate: 35_000, consumers: 12 },
      20261110,
      20,
    );
    const depth = (frame: typeof ten) => frame.metrics.find((item) => item.id === "queueDepth")?.value ?? 0;
    expect(depth(ten)).toBeGreaterThan(0);
    expect(depth(twelve)).toBeCloseTo(depth(ten), 4);
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(4);
    expect(presets.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "scale"]),
    );
    expect(preset("failure").elapsed).toBe(15);
    expect(preset("peak").elapsed).toBe(60);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
