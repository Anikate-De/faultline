import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { blueGreenDbMigrationModel as model, module } from "./module";

const presets = module.sims["blue-green-migration"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("deployment-blue-green-db-migration model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or out-of-range utilization", () => {
    for (const id of ["healthy", "peak", "failure", "recovery", "contract-after-drain"]) {
      const frame = runModel(model, params(id), 7, 60);
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
        for (const value of values) expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("starts healthy with no threshold or failing node", () => {
    const frame = runModel(model, params("healthy"), 20261110, 0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "old-version-error")).toBeGreaterThan(3);
    expect(metricValue(frame, "rollback-blocked")).toBe(100);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "rollback-blocked")).toBe(0);
  });

  it("keeps the previous version healthy while the new version is missing its schema", () => {
    const frame = runModel(model, { ...params("healthy"), migrationPhase: 0 }, 20261110, 30);
    expect(metricValue(frame, "new-version-error")).toBeGreaterThan(3);
    expect(metricValue(frame, "old-version-error")).toBeLessThan(1);
  });

  it("blocks rollback after the contract step even when no old traffic remains", () => {
    const frame = runModel(model, params("contract-after-drain"), 20261110, 30);
    expect(metricValue(frame, "old-version-error")).toBe(0);
    expect(metricValue(frame, "rollback-blocked")).toBe(100);
    expect(activeThreshold(frame, model.thresholds)?.threshold.id).toBe("rollback-blocked");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-old-version-error-crit");
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("the experiment fix keeps both versions compatible", () => {
    const experiment = module.experiments[0];
    if (!experiment.fix) throw new Error("Missing experiment fix");
    const before = runModel(model, experiment.setup, 20261110, experiment.runFor);
    const after = runModel(model, experiment.fix, 20261110, experiment.runFor);
    expect(activeThreshold(before, model.thresholds)?.severity).toBe("crit");
    expect(activeThreshold(after, model.thresholds)).toBeNull();
    expect(metricValue(after, "rollback-blocked")).toBe(0);
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
    expect(model.params).toHaveLength(4);
    expect(presets).toHaveLength(5);
    expect(module.experiments).toHaveLength(1);
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
