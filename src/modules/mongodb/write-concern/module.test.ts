import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, writeConcernModel } from "./module";

const model = writeConcernModel;
const presets = module.sims["write-concern"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("mongodb-write-concern model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
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
    const frame = runModel(model, params("failure"), 20261110, 5);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "lost-writes")).toBeGreaterThan(100);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "lost-writes")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-lost-writes-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("journaling does not save w:1 writes from a primary node loss", () => {
    const noJournal = runModel(
      model,
      { ...params("failure"), journal: 0 },
      20261110,
      15,
    );
    const withJournal = runModel(
      model,
      { ...params("failure"), journal: 1 },
      20261110,
      15,
    );
    expect(metricValue(noJournal, "lost-writes")).toBeGreaterThan(0);
    expect(metricValue(withJournal, "lost-writes")).toBeGreaterThan(0);
    expect(metricValue(withJournal, "ack-copies")).toBe(0);
  });

  it("majority survives the same node loss", () => {
    const frame = runModel(model, params("majority"), 20261110, 15);
    expect(metricValue(frame, "lost-writes")).toBe(0);
    expect(metricValue(frame, "ack-copies")).toBe(1);
    expect(frame.nodes.find((node) => node.id === "primary")?.health).toBe("down");
  });

  it("w:1 has a lower write latency cost than majority", () => {
    const w1 = runModel(model, { ...params("healthy"), wMode: 0, journal: 0 }, 1, 5);
    const majority = runModel(model, { ...params("healthy"), wMode: 2, journal: 1 }, 1, 5);
    expect(metricValue(w1, "write-p99")).toBeLessThan(metricValue(majority, "write-p99"));
  });

  it("an unsatisfiable concern fails writes instead of silently weakening", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), secondariesAvailable: 0, wMode: 2, primaryLost: 0 },
      20261110,
      10,
    );
    expect(metricValue(frame, "write-error-rate")).toBe(100);
    expect(metricValue(frame, "ack-copies")).toBe(0);
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
      "majority",
      "recovery",
    ]);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
