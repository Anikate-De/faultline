import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { consumerLagModel, module } from "./module";

const model = consumerLagModel;
const presets = module.sims["consumer-lag"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (id: string, seconds: number, presetId: string) =>
  runModel(model, params(presetId), 20261110, seconds).metrics.find((item) => item.id === id)?.value ?? 0;

describe("streaming-consumer-lag model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 60);
    const b = runModel(model, params("failure"), 42, 60);
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
    const frame = runModel(model, params("failure"), 20261110, 1);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "drain-shortfall")?.value).toBeGreaterThan(2_000);
    expect(frame.metrics.find((item) => item.id === "catch-up-time")?.value).toBe(86_400);
  });

  it("grows lag when consumer capacity is below production", () => {
    const early = runModel(model, params("failure"), 20261110, 1);
    const later = runModel(model, params("failure"), 20261110, 31);
    const lag = (frame: typeof early) => frame.metrics.find((item) => item.id === "consumer-lag")?.value ?? 0;
    expect(lag(later)).toBeGreaterThan(lag(early));
    expect(lag(later)).toBeGreaterThan(2_000_000);
  });

  it("shrinks lag when consumer capacity is above production", () => {
    const early = runModel(model, params("recovery"), 20261110, 1);
    const later = runModel(model, params("recovery"), 20261110, 61);
    const lag = (frame: typeof early) => frame.metrics.find((item) => item.id === "consumer-lag")?.value ?? 0;
    expect(lag(later)).toBeLessThan(lag(early));
    expect(lag(later)).toBeGreaterThan(0);
  });

  it("keeps lag at zero when the group is healthy", () => {
    const frame = runModel(model, params("healthy"), 20261110, 60);
    expect(frame.metrics.find((item) => item.id === "consumer-lag")?.value).toBe(0);
  });

  it("returns to ok within 60 seconds on the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.metrics.find((item) => item.id === "catch-up-time")?.value).toBeLessThan(300);
  });

  it("does not treat a large lag as bad when capacity exceeds production", () => {
    const frame = runModel(model, params("recovery"), 20261110, 1);
    expect(frame.metrics.find((item) => item.id === "consumer-lag")?.value).toBeGreaterThan(1_900_000);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("warns at peak with a large but draining backlog", () => {
    const frame = runModel(model, params("peak"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(frame.metrics.find((item) => item.id === "drain-shortfall")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "catch-up-time")?.value).toBeLessThan(1_200);
  });

  it("adding one consumer does not fix a capacity shortfall", () => {
    const oneMore = runModel(model, params("one-more"), 20261110, 30);
    expect(activeThreshold(oneMore, model.thresholds)?.severity).toBe("crit");
    expect(oneMore.metrics.find((item) => item.id === "drain-shortfall")?.value).toBeGreaterThan(2_000);
    expect(metricValue("catch-up-time", 60, "recovery")).toBeLessThan(300);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-drain-shortfall-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "lag-never-drains").length).toBe(1);
  });

  it("preserves flags across steps", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.flags.seed).toBe(20261110);
    expect(frame.flags.neverDrains).toBe(1);
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

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(4);
    expect(presets.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "one-more"]),
    );
    expect(preset("peak").elapsed).toBe(60);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
