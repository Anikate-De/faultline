import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, topologyModel } from "./module";

const model = topologyModel;
const presets = module.sims["multi-az-vs-region"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const node = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.nodes.find((item) => item.id === id);

describe("databases-multi-az-vs-region model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or out-of-range utilization", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const item of frame.nodes) {
      expect(item.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(item.utilization ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "rto")).toBe(1_440);
    expect(node(frame, "writer")?.health).toBe("down");
    expect(node(frame, "standby")?.health).toBe("down");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "rto")).toBe(12);
    expect(metricValue(frame, "rpo")).toBe(20);
  });

  it("keeps the AZ failure inside RPO 0 with Multi-AZ", () => {
    const frame = runModel(model, params("az-failure"), 20261110, 20);
    expect(metricValue(frame, "rto")).toBe(2.5);
    expect(metricValue(frame, "rpo")).toBe(0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps a cross-Region promotion warning while both budgets stay under critical", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(metricValue(frame, "rto")).toBe(18);
    expect(metricValue(frame, "rpo")).toBe(90);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("does not let Multi-AZ cover a Region failure", () => {
    const multiAz = runModel(model, { ...params("failure"), topology: 1, failureDomain: 2 }, 20261110, 20);
    const multiRegion = runModel(model, { ...params("failure"), topology: 2, failureDomain: 2 }, 20261110, 20);
    expect(metricValue(multiAz, "rto")).toBe(1_440);
    expect(metricValue(multiRegion, "rto")).toBe(14);
  });

  it("keeps exactly one event per topology and failure-domain combination", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "failure-1-2").length).toBe(1);
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
    expect(model.params.length).toBeGreaterThanOrEqual(3);
    expect(model.params.length).toBeLessThanOrEqual(6);
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
