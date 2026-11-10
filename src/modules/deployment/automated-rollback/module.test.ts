import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { automatedRollbackModel as model, module } from "./module";

const presets = module.sims["rollback-release"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("deployment-automated-rollback model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or out-of-range utilization", () => {
    for (const id of ["healthy", "peak", "failure", "recovery", "late-gate"]) {
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
    }
  });

  it("starts healthy with no threshold or failing node", () => {
    const frame = runModel(model, params("healthy"), 20261110, 0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "recovery-seconds")).toBeGreaterThan(300);
    expect(metricValue(frame, "release-error-rate")).toBeGreaterThan(5);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "recovery-seconds")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-release-error-rate-crit");
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("preserves model flags across buildFrame", () => {
    let frame = initModel(model, params("healthy"), 23);
    frame.flags.seriesSeeded = 1;
    frame = stepModel(model, frame, params("healthy"), createRng(23));
    expect(frame.flags.seriesSeeded).toBe(1);
    expect(frame.flags.seed).toBe(23);
  });

  it("does not trigger a rollback below the error gate", () => {
    const frame = runModel(model, params("healthy"), 20261110, 30);
    expect(metricValue(frame, "recovery-seconds")).toBe(0);
    expect(metricValue(frame, "error-exposure")).toBe(0);
    expect(frame.nodes.find((node) => node.id === "controller")?.sublabel).toContain("Standby");
  });

  it("models a longer recovery when the previous artifact is missing", () => {
    const retained = runModel(model, { ...params("failure"), previousArtifactRetained: 1 }, 20261110, 30);
    const missing = runModel(model, params("failure"), 20261110, 30);
    expect(metricValue(retained, "recovery-seconds")).toBeLessThan(metricValue(missing, "recovery-seconds"));
    expect(metricValue(missing, "recovery-seconds")).toBe(1_260);
    expect(metricValue(missing, "artifact-ready")).toBe(0);
  });

  it("longer detection increases exposure even with an artifact", () => {
    const fast = runModel(model, { ...params("failure"), previousArtifactRetained: 1, detectionWindowSeconds: 30 }, 20261110, 30);
    const slow = runModel(model, { ...params("failure"), previousArtifactRetained: 1, detectionWindowSeconds: 240 }, 20261110, 30);
    expect(metricValue(slow, "recovery-seconds")).toBeGreaterThan(metricValue(fast, "recovery-seconds"));
    expect(metricValue(slow, "error-exposure")).toBeGreaterThan(metricValue(fast, "error-exposure"));
  });

  it("the experiment fix clears the recovery gates", () => {
    const experiment = module.experiments[0];
    if (!experiment.fix) throw new Error("Missing experiment fix");
    const before = runModel(model, experiment.setup, 20261110, experiment.runFor);
    const after = runModel(model, experiment.fix, 20261110, experiment.runFor);
    expect(activeThreshold(before, model.thresholds)?.severity).toBe("crit");
    expect(activeThreshold(after, model.thresholds)).toBeNull();
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
