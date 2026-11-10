import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { costAllocationModel, module } from "./module";

const model = costAllocationModel;
const presets = module.sims["cost-allocation"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("capacity-cost-allocation model", () => {
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
    for (const series of Object.values(frame.series)) {
      for (const point of series) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("keeps allocated and unowned spend equal to the bill", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    const total = 480;
    expect(value(frame, "allocated-cost") + value(frame, "unallocated-cost")).toBeCloseTo(total, 5);
    expect(value(frame, "unallocated-share")).toBeGreaterThan(25);
  });

  it("stays healthy when tags and shared rules cover the bill", () => {
    const frame = runModel(model, params("healthy"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "unallocated-share")).toBeLessThan(10);
  });

  it("crosses critical within 45 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "unallocated-cost")).toBeGreaterThan(150);
    expect(value(frame, "unallocated-share")).toBeGreaterThan(25);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "unallocated-share")).toBeLessThan(10);
  });

  it("shows that tag coverage closes a larger gap than the shared rule here", () => {
    const base = { ...params("failure"), monthlySpendK: 420, taggedSharePct: 55, sharedSpendPct: 20, sharedRulePct: 15 };
    const tagged = runModel(model, { ...base, taggedSharePct: 95 }, 20261110, 10);
    const shared = runModel(model, { ...base, sharedRulePct: 100 }, 20261110, 10);
    expect(value(tagged, "unallocated-cost")).toBeLessThan(value(shared, "unallocated-cost"));
  });

  it("reaches zero unowned spend when every mechanism is complete", () => {
    const frame = runModel(model, params("shared-platform"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "unallocated-cost")).toBeCloseTo(0, 6);
    expect(value(frame, "shared-cost")).toBeGreaterThan(0);
  });

  it("emits the month-close event once and deduplicates threshold events", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "allocation-close")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "threshold-unallocated-cost-crit")).toHaveLength(1);
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
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
