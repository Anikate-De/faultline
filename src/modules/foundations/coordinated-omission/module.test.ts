import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { coordinatedOmissionModel, module } from "./module";

const model = coordinatedOmissionModel;
const presets = module.sims["coordinated-omission"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("foundations-coordinated-omission model", () => {
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
      for (const item of values) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("shows a healthy reported p99 with an exploding corrected p99", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "reported-p99")).toBeLessThan(300);
    expect(value(frame, "corrected-p99")).toBeGreaterThan(1_500);
    expect(value(frame, "p99-gap")).toBeGreaterThan(10);
    expect(value(frame, "rate-shortfall")).toBeGreaterThan(5);
    expect(value(frame, "omitted")).toBeGreaterThan(2_000);
  });

  it("returns to ok within 60 seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "corrected-p99")).toBeLessThan(500);
  });

  it("warns without failing in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "reported-p99")).toBeLessThan(300);
    expect(value(frame, "corrected-p99")).toBeGreaterThan(500);
  });

  it("open loop reveals the stall without changing the service", () => {
    const closed = runModel(model, params("failure"), 20261110, 20);
    const open = runModel(model, params("open-loop"), 20261110, 20);
    expect(value(open, "reported-p99")).toBeGreaterThan(1_500);
    expect(value(open, "corrected-p99")).toBeCloseTo(value(open, "reported-p99"), 5);
    expect(value(open, "omitted")).toBe(0);
    expect(value(open, "stall-share")).toBeCloseTo(value(closed, "stall-share"), 5);
  });

  it("correction bridges reported and intended latency in a closed loop", () => {
    const none = runModel(model, { ...params("failure"), correction: 0 }, 20261110, 20);
    const full = runModel(model, { ...params("failure"), correction: 100 }, 20261110, 20);
    expect(value(none, "corrected-p99")).toBeCloseTo(value(none, "reported-p99"), 5);
    expect(value(full, "corrected-p99")).toBeGreaterThan(value(none, "corrected-p99") * 10);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-corrected-p99-crit");
    expect(critical.length).toBe(1);
    expect(frame.events.filter((event) => event.id === "omission-detected").length).toBe(1);
  });

  it("keeps the healthy preset's 60-second stall interval consistent with its copy", () => {
    expect(params("healthy").stallEvery).toBe(60);
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
    expect(model.params.length).toBe(5);
    expect(module.sims["coordinated-omission"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
