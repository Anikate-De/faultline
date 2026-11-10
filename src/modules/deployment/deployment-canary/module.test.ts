import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { canaryDeploymentsModel as model, module } from "./module";

const presets = module.sims["canary-release"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("deployment-canary model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or out-of-range utilization", () => {
    for (const id of ["healthy", "peak", "failure", "recovery", "large-slice"]) {
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
    expect(metricValue(frame, "canary-error-rate")).toBe(8);
    expect(metricValue(frame, "blended-error-rate")).toBeLessThan(1);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-canary-error-rate-crit");
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("preserves model flags across buildFrame", () => {
    let frame = initModel(model, params("healthy"), 17);
    frame.flags.seriesSeeded = 1;
    frame = stepModel(model, frame, params("healthy"), createRng(17));
    expect(frame.flags.seriesSeeded).toBe(1);
    expect(frame.flags.seed).toBe(17);
  });

  it("dilutes canary errors in the blended rate at a small share", () => {
    const small = runModel(model, params("failure"), 20261110, 20);
    const large = runModel(model, params("large-slice"), 20261110, 20);
    expect(metricValue(small, "canary-error-rate")).toBe(8);
    expect(metricValue(small, "blended-error-rate")).toBeCloseTo(0.495, 3);
    expect(metricValue(large, "blended-error-rate")).toBeGreaterThan(3);
    expect(metricValue(small, "blended-error-rate")).toBeLessThan(metricValue(large, "blended-error-rate"));
  });

  it("shows a passing gate while the canary is critical", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const gate = frame.nodes.find((node) => node.id === "gate");
    expect(gate?.label).toContain("PASS");
    expect(gate?.health).toBe("crit");
    expect(frame.nodes.find((node) => node.id === "canary")?.health).toBe("crit");
  });

  it("blocks promotion when the canary share makes the blended rate cross the gate", () => {
    const frame = runModel(model, params("large-slice"), 20261110, 20);
    const gate = frame.nodes.find((node) => node.id === "gate");
    expect(gate?.label).toContain("BLOCKED");
    expect(metricValue(frame, "user-impact")).toBeGreaterThan(2);
  });

  it("the experiment fix clears the canary gate", () => {
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
