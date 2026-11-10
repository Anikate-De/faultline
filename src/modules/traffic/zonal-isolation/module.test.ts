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
import { module, zonalIsolationModel } from "./module";

const model = zonalIsolationModel;
const presets = module.sims["zonal-isolation"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
describe("traffic-zonal-isolation model", () => {
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

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "error-rate")?.value).toBeGreaterThan(5);
    expect(frame.nodes.find((node) => node.id === "az-0")?.health).toBe("down");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "threshold-error-rate-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "zone-failure").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["error-rate"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("keeps node utilization consistent with served throughput and capacity", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const pressure = frame.metrics.find((item) => item.id === "zone-demand-pressure")?.value ?? 0;
    expect(pressure).toBeGreaterThan(100);
    for (const node of frame.nodes.filter((item) => item.id.startsWith("az-") && item.health !== "down")) {
      expect(node.utilization ?? 0).toBeCloseTo((node.throughput ?? 0) / (node.capacity ?? 1), 6);
      expect(node.utilization ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it("separates capacity shortfall from dependency loss", () => {
    const capacity = runModel(model, params("failure"), 20261110, 20);
    const dependency = runModel(model, params("dependency"), 20261110, 20);
    const byId = (frame: typeof capacity, id: string) =>
      frame.metrics.find((item) => item.id === id)?.value ?? 0;
    expect(byId(capacity, "capacity-shortfall")).toBeGreaterThan(30);
    expect(byId(capacity, "dependency-loss")).toBe(0);
    expect(byId(dependency, "capacity-shortfall")).toBe(0);
    expect(byId(dependency, "dependency-loss")).toBe(40);
    expect(byId(dependency, "error-rate")).toBe(40);
  });

  it("adds capacity and dependency failures together into the error rate", () => {
    const frame = runModel(
      model,
      { ...params("failure"), headroom: 20, sharedDependency: 40 },
      20261110,
      20,
    );
    const byId = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    expect(byId("capacity-shortfall")).toBeCloseTo(20, 5);
    expect(byId("dependency-loss")).toBe(40);
    expect(byId("error-rate")).toBeCloseTo(60, 5);
  });

  it("shows that cross-zone capacity cannot beat missing headroom", () => {
    const noHeadroom = runModel(model, params("failure"), 20261110, 20);
    const headroom = runModel(model, { ...params("failure"), headroom: 75 }, 20261110, 20);
    expect(noHeadroom.metrics.find((item) => item.id === "error-rate")?.value ?? 0).toBeGreaterThan(5);
    expect(headroom.metrics.find((item) => item.id === "error-rate")?.value ?? 0).toBe(0);
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
    expect(presets.length).toBe(5);
    expect(module.experiments.length).toBe(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
