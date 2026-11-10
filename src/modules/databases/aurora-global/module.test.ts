import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { globalModel, module } from "./module";

const model = globalModel;
const presets = module.sims["aurora-global"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const node = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.nodes.find((item) => item.id === id);

describe("databases-aurora-global model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps the healthy preset calm at t=0", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
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
      for (const item of values) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses the RPO and a critical threshold during a saturated write burst", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "replication-lag")).toBeGreaterThan(5);
    expect(value(frame, "rpo-overrun")).toBeGreaterThan(0);
    expect(value(frame, "link-utilization")).toBeGreaterThan(120);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "replication-lag")).toBeLessThan(0.1);
    expect(frame.nodes.filter((item) => item.health !== "ok")).toEqual([]);
  });

  it("swaps the writer and exposes the lag at promotion", () => {
    const frame = runModel(model, params("promoted"), 20261110, 20);
    expect(node(frame, "secondary")?.role).toBe("primary");
    expect(node(frame, "primary")?.role).toBe("replica");
    expect(node(frame, "primary")?.health).toBe("down");
    expect(node(frame, "secondary")?.health).toBe("crit");
    expect(value(frame, "promotion-lag")).toBeGreaterThan(5);
    expect(value(frame, "replication-lag")).toBe(0);
    expect(value(frame, "link-utilization")).toBe(0);
    expect(value(frame, "replay-shortfall")).toBe(0);
    expect(value(frame, "rpo-overrun")).toBeGreaterThan(4);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(activeThreshold(frame, model.thresholds)?.threshold.id).toBe("promotion-lag");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-replication-lag-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "global-replication-behind").length).toBe(1);
    const promoted = runModel(model, params("promoted"), 20261110, 20);
    expect(promoted.events.filter((event) => event.id === "threshold-promotion-lag-crit").length).toBe(1);
    expect(promoted.events.filter((event) => event.id === "secondary-promoted").length).toBe(1);
  });

  it("caps link utilization consistently at 300 percent", () => {
    const frame = runModel(model, { ...params("failure"), writeRate: 30_000, writeSizeKb: 16, linkBandwidth: 10 }, 1, 10);
    expect(value(frame, "link-utilization")).toBe(300);
    expect(value(frame, "replication-lag")).toBeGreaterThan(0);
  });

  it("keeps the secondary below the warning band at peak before the burst accumulates", () => {
    const frame = runModel(model, params("peak"), 20261110, 1);
    expect(value(frame, "replication-lag")).toBeLessThan(1);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
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
    expect(presets.map((item) => item.id)).toEqual([
      "healthy",
      "peak",
      "failure",
      "promoted",
      "recovery",
    ]);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
