import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { coldSecondaryModel, module } from "./module";

const model = coldSecondaryModel;
const presets = module.sims["cold-secondary"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const node = (frame: ReturnType<typeof runModel>, id: string) => frame.nodes.find((item) => item.id === id);

describe("mongodb-cold-secondary model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps the healthy preset calm at t=0", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(frame.nodes.filter((item) => item.health !== "ok")).toEqual([]);
  });

  it("never reports NaN, Infinity, or out-of-range utilization", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const item of frame.nodes) {
      expect(Number.isFinite(item.utilization ?? 0)).toBe(true);
      expect(item.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(item.utilization ?? 0).toBeLessThanOrEqual(1);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 5);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "read-p99")).toBeGreaterThan(120);
    expect(node(frame, "replica-new")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "read-p99")).toBeLessThan(50);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-read-p99-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("keeps CPU low while p99 is high on a cold member", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    expect(metricValue(frame, "primary-cpu")).toBeLessThan(70);
    expect(metricValue(frame, "read-p99")).toBeGreaterThan(120);
    expect(metricValue(frame, "cache-hit-rate")).toBeLessThan(20);
  });

  it("removes latency when reads are not routed to the new member", () => {
    const cold = runModel(model, params("failure"), 20261110, 10);
    const warmPath = runModel(model, { ...params("failure"), readOffload: 0 }, 20261110, 10);
    expect(metricValue(cold, "read-p99")).toBeGreaterThan(120);
    expect(metricValue(warmPath, "read-p99")).toBeLessThan(50);
    expect(metricValue(warmPath, "disk-io-util")).toBe(0);
  });

  it("warms and lowers the miss rate over time", () => {
    const early = runModel(model, params("failure"), 20261110, 2);
    const later = runModel(model, params("failure"), 20261110, 50);
    expect(metricValue(later, "cache-hit-rate")).toBeGreaterThan(metricValue(early, "cache-hit-rate"));
    expect(metricValue(later, "missed-reads")).toBeLessThan(metricValue(early, "missed-reads"));
  });

  it("starts warmup when reads first reach the new member", () => {
    let frame = initModel(model, params("healthy"), 20261110);
    const rng = createRng(20261110);
    for (let index = 0; index < 300; index++) {
      frame = stepModel(model, frame, params("healthy"), rng);
    }
    expect(Number(frame.flags.warmStartedAt)).toBe(-1);
    frame = stepModel(model, frame, { ...params("healthy"), readOffload: 60 }, rng);
    expect(Number(frame.flags.warmStartedAt)).toBeGreaterThan(25);
    expect(metricValue(frame, "cache-hit-rate")).toBeLessThan(5);
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
    expect(presets).toHaveLength(4);
    expect(presets.map((item) => item.id)).toEqual(["healthy", "peak", "failure", "recovery"]);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
