import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, ramModel } from "./module";

const model = ramModel;
const presets = module.sims["ram-attachments"].presets;
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

describe("cloud-networking-ram model", () => {
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

  it("loads healthy at t=0 with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "attached-accounts")).toBe(4);
    expect(metricValue(frame, "pending-attachments")).toBe(0);
    expect(metricValue(frame, "rejected-attachments")).toBe(0);
  });

  it("crosses critical within 30 simulated seconds when attachment capacity is exhausted", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "attached-accounts")).toBe(2);
    expect(metricValue(frame, "rejected-attachments")).toBe(3);
    expect(metricValue(frame, "share-coverage")).toBe(50);
    expect(node(frame, "owner")?.health).toBe("crit");
    expect(node(frame, "attachments")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "attached-accounts")).toBe(4);
    expect(metricValue(frame, "rejected-attachments")).toBe(0);
    expect(metricValue(frame, "share-coverage")).toBe(100);
  });

  it("distinguishes a pending attachment from a rejected one", () => {
    const pending = runModel(
      model,
      { ...params("healthy"), autoAccept: 0 },
      20261110,
      20,
    );
    const rejected = runModel(model, params("failure"), 20261110, 20);
    expect(metricValue(pending, "pending-attachments")).toBe(4);
    expect(metricValue(pending, "attached-accounts")).toBe(0);
    expect(metricValue(pending, "rejected-attachments")).toBe(0);
    expect(metricValue(pending, "share-coverage")).toBe(0);
    expect(metricValue(rejected, "pending-attachments")).toBe(0);
    expect(metricValue(rejected, "rejected-attachments")).toBe(3);
  });

  it("flags over-sharing without a capacity failure", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(metricValue(frame, "excess-accounts")).toBe(1);
    expect(metricValue(frame, "rejected-attachments")).toBe(0);
    expect(metricValue(frame, "attached-accounts")).toBe(5);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("keeps the first pending event when events are deduplicated", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), autoAccept: 0 },
      20261110,
      60,
    );
    expect(frame.events.filter((event) => event.id === "auto-accept-disabled")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "threshold-pending-attachments-crit")).toHaveLength(1);
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
