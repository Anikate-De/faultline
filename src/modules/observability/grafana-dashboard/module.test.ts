import { describe, expect, it } from "vitest";
import {
  activeNodeIncident,
  activeThreshold,
  initModel,
  runModel,
  stepModel,
  TICK,
} from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { dashboardModel, module } from "./module";

const model = dashboardModel;
const presets = module.sims["grafana-dashboard"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-grafana-dashboard model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
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
    for (const values of Object.values(frame.series)) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "time-to-answer")).toBeGreaterThan(120);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first decision-timeout event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const events = frame.events.filter((event) => event.id === "decision-timeout");
    expect(events.length).toBe(1);
    expect(events[0].severity).toBe("crit");
  });

  it("reduces time to answer when the dashboard is focused", () => {
    const failure = runModel(model, params("failure"), 20261110, 20);
    const recovery = runModel(model, params("recovery"), 20261110, 20);
    expect(metricValue(recovery, "time-to-answer")).toBeLessThan(
      metricValue(failure, "time-to-answer"),
    );
    expect(metricValue(recovery, "panels")).toBeLessThan(metricValue(failure, "panels"));
    expect(metricValue(recovery, "threshold-gap")).toBeLessThan(
      metricValue(failure, "threshold-gap"),
    );
    expect(metricValue(failure, "canary-error")).toBeGreaterThan(
      metricValue(failure, "stable-error"),
    );
  });

  it("ranks dashboard changes by decision time", () => {
    const base = params("failure");
    const time = (overrides: Record<string, number>) =>
      metricValue(runModel(model, { ...base, ...overrides }, 20261110, 5), "time-to-answer");
    const move = time({ keyPanelRank: 1 });
    const cut = time({ panelCount: 10 });
    const coverage = time({ thresholdCoverage: 100 });
    const annotations = time({ annotationDensity: 0 });
    expect(move).toBeLessThan(cut);
    expect(cut).toBeLessThan(coverage);
    expect(coverage).toBeLessThan(annotations);
    expect(module.experiments.length).toBe(2);
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
    for (const metric of fast.metrics) {
      const other = stepped.metrics.find((item) => item.id === metric.id);
      expect(other?.value).toBeCloseTo(metric.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(4);
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
