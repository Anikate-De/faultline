import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { addingReadersModel, module } from "./module";

const model = addingReadersModel;
const presets = module.sims["adding-readers"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("mongodb-adding-readers model", () => {
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

  it("saturates the primary within 30 simulated seconds when two members sync", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "primary-cpu")).toBeGreaterThan(85);
    expect(metricValue(frame, "sync-progress")).toBeLessThan(100);
    expect(metricValue(frame, "replication-lag")).toBeGreaterThan(6);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "primary-cpu")).toBeLessThan(70);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-primary-cpu-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("shows that adding members raises primary load before sync completes", () => {
    const base = runModel(model, params("healthy"), 20261110, 20);
    const added = runModel(model, params("failure"), 20261110, 20);
    expect(metricValue(added, "primary-cpu")).toBeGreaterThan(metricValue(base, "primary-cpu"));
    expect(metricValue(added, "sync-progress")).toBeLessThan(100);
  });

  it("a secondary sync source protects the primary but loads that secondary", () => {
    const primarySource = runModel(model, params("failure"), 20261110, 20);
    const secondarySource = runModel(model, params("secondary-source"), 20261110, 20);
    expect(metricValue(secondarySource, "primary-cpu")).toBeLessThan(
      metricValue(primarySource, "primary-cpu"),
    );
    expect(metricValue(secondarySource, "sync-source-cpu")).toBeGreaterThan(60);
    expect(metricValue(secondarySource, "replication-lag")).toBeGreaterThan(5);
    expect(metricValue(secondarySource, "sync-progress")).toBeLessThan(100);
  });

  it("routing reads after sync lowers primary CPU and exposes cold-read latency", () => {
    const noReads = runModel(model, params("failure"), 20261110, 60);
    const routed = runModel(
      model,
      { ...params("route-reads"), readOffload: 100 },
      20261110,
      40,
    );
    expect(metricValue(routed, "primary-cpu")).toBeLessThan(metricValue(noReads, "primary-cpu"));
    expect(metricValue(routed, "new-secondary-p99")).toBeGreaterThan(100);
    expect(metricValue(routed, "effective-offload")).toBeGreaterThan(0);
  });

  it("completes sync and keeps the member readable without a cold-read penalty when no reads are routed", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(metricValue(frame, "sync-progress")).toBe(100);
    expect(metricValue(frame, "new-secondary-p99")).toBe(0);
    expect(metricValue(frame, "effective-offload")).toBe(0);
  });

  it("the guided fix returns the model to ok", () => {
    const experiment = module.experiments[0];
    if (!experiment.fix) throw new Error("Missing experiment fix");
    const frame = runModel(model, experiment.fix, 20261110, experiment.runFor);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
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
    expect(module.sims["adding-readers"].presets).toHaveLength(6);
    expect(module.sims["adding-readers"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
