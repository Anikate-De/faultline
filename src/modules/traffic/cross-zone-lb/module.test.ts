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
import { crossZoneLbModel, module } from "./module";

const model = crossZoneLbModel;
const presets = module.sims["cross-zone-lb"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 20) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("traffic-cross-zone-lb model", () => {
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

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "az-b-util")?.value).toBe(100);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("fires the zone saturation event once and preserves flags", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "zone-saturated")).toHaveLength(1);
    expect(frame.flags.zoneSaturated).toBe(1);
    expect(frame.flags.seed).toBe(20261110);
    expect(typeof frame.flags.paramsKey).toBe("string");
  });

  it("pools zonal capacity only when cross-zone is on", () => {
    expect(valueOf("failure", "az-a-util")).toBe(50);
    expect(valueOf("failure", "az-b-util")).toBe(100);
    expect(valueOf("failure", "overload-5xx")).toBeGreaterThan(0);
    expect(valueOf("healthy", "az-a-util")).toBe(75);
    expect(valueOf("healthy", "az-b-util")).toBe(75);
    expect(valueOf("healthy", "overload-5xx")).toBe(0);
  });

  it("reports stranded capacity only when a zone is overloaded with cross-zone off", () => {
    expect(valueOf("failure", "stranded")).toBe(50);
    expect(valueOf("peak", "stranded")).toBe(0);
    expect(valueOf("healthy", "stranded")).toBe(0);
  });

  it("shows cross-zone data only when traffic crosses zones", () => {
    expect(valueOf("healthy", "cross-zone-data")).toBeGreaterThan(0);
    expect(valueOf("failure", "cross-zone-data")).toBe(0);
  });

  it("runs the experiment on the zonal skew it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-zonal-skew");
    expect(experiment?.setup.crossZone).toBe(0);
    expect(experiment?.setup.azBTargets).toBe(2);
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
      const other = stepped.metrics.find((entry) => entry.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(4);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.interview.length).toBe(module.meta.interviewQuestions);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
