import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, percentilesModel } from "./module";

const model = percentilesModel;
const presets = module.sims.percentiles.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("foundations-percentiles model", () => {
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

  it("shows one percent timing out while the mean stays under its SLO", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "mean")).toBeLessThan(300);
    expect(value(frame, "timeout-rate")).toBeGreaterThanOrEqual(1);
    expect(value(frame, "p99")).toBeGreaterThan(1_500);
    expect(value(frame, "p50")).toBe(36);
    expect(value(frame, "p95")).toBe(36);
    expect(frame.nodes.find((node) => node.id === "service")?.health).toBe("crit");
  });

  it("returns to ok within 60 seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "timeout-rate")).toBe(0);
    expect(frame.nodes.filter((node) => node.health === "warn" || node.health === "crit")).toEqual([]);
  });

  it("warns without failing in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-p99-crit");
    expect(critical.length).toBe(1);
    expect(frame.events.filter((event) => event.id === "tail-hidden").length).toBe(1);
  });

  it("keeps percentiles ordered and moves the tail before the median", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(value(frame, "p50")).toBeLessThanOrEqual(value(frame, "p95"));
    expect(value(frame, "p95")).toBeLessThanOrEqual(value(frame, "p99"));
    expect(value(frame, "p99")).toBeLessThanOrEqual(value(frame, "p999"));
    expect(value(frame, "p999")).toBeGreaterThan(3_000);
  });

  it("raising the slow share increases the mean and timeout rate", () => {
    const base = runModel(model, { ...params("failure"), slowShare: 1 }, 20261110, 20);
    const wide = runModel(model, { ...params("failure"), slowShare: 4 }, 20261110, 20);
    expect(value(wide, "mean")).toBeGreaterThan(value(base, "mean"));
    expect(value(wide, "timeout-rate")).toBeGreaterThan(value(base, "timeout-rate"));
    expect(value(wide, "p99")).toBeGreaterThan(value(base, "p99"));
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
    expect(module.sims.percentiles.presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
