import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, replicationLagModel } from "./module";

const model = replicationLagModel;
const presets = module.sims["replication-lag"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("mongodb-replication-lag model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 60);
    const b = runModel(model, params("failure"), 42, 60);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps the healthy preset calm at t=0", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.filter((node) => node.health !== "ok")).toEqual([]);
  });

  it("never reports NaN, Infinity, or out-of-range utilization", () => {
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
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "replication-lag")).toBeGreaterThan(20);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "replication-lag")).toBe(0);
    expect(metricValue(frame, "oplog-shortfall")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-replication-lag-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("falls off the oplog when the write burst outlasts the window", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(metricValue(frame, "oplog-shortfall")).toBeGreaterThan(1);
    expect(frame.nodes.find((node) => node.id === "secondary")?.health).toBe("down");
    expect(frame.flags.resync).toBe(1);
  });

  it("a larger oplog keeps the same burst on the oplog", () => {
    const small = runModel(model, params("failure"), 20261110, 60);
    const large = runModel(model, params("large-oplog"), 20261110, 60);
    expect(metricValue(large, "oplog-window")).toBeGreaterThan(metricValue(small, "oplog-window"));
    expect(metricValue(large, "oplog-shortfall")).toBe(0);
    expect(metricValue(large, "replication-lag")).toBeGreaterThan(20);
    expect(large.nodes.find((node) => node.id === "secondary")?.health).not.toBe("down");
  });

  it("a paused secondary falls behind and eventually needs a resync", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), writeRate: 32_000, applyCapacity: 8_000, oplogSizeMB: 2_048, entryBytes: 2_048, secondaryPaused: 0 },
      20261110,
      60,
    );
    expect(frame.flags.resync).toBe(1);
    expect(metricValue(frame, "oplog-shortfall")).toBeGreaterThan(1);
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
    expect(presets).toHaveLength(5);
    expect(presets.map((item) => item.id)).toEqual([
      "healthy",
      "peak",
      "failure",
      "large-oplog",
      "recovery",
    ]);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
