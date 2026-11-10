import { describe, expect, it } from "vitest";
import {
  activeNodeIncident,
  activeThreshold,
  applyPresetFrame,
  initModel,
  runModel,
  stepModel,
  TICK,
} from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { clusterReshardingModel, module } from "./module";
import { meta } from "./meta";

const model = clusterReshardingModel;
const presets = module.sims["cluster-resharding"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("caching-cluster-resharding model", () => {
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
      expect(Number.isFinite(node.throughput ?? 0)).toBe(true);
      expect(node.throughput ?? 0).toBeGreaterThanOrEqual(0);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("loads the healthy preset with no active incident", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    const stepped = applyPresetFrame(model, preset("healthy"), 20261110);
    expect(activeThreshold(stepped, model.thresholds)).toBeNull();
    expect(activeNodeIncident(stepped)).toBeNull();
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "request-errors")).toBeGreaterThan(2);
    expect(metricValue(frame, "migration-progress")).toBe(100);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical redirect event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "redirects-ignored");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("removes errors when the same reshard has redirect-aware clients", () => {
    const blind = runModel(model, params("failure"), 20261110, 8);
    const aware = runModel(model, { ...params("failure"), redirectSupport: 100 }, 20261110, 8);
    expect(metricValue(blind, "request-errors")).toBeGreaterThan(2);
    expect(metricValue(aware, "request-errors")).toBe(0);
    expect(metricValue(aware, "ask-redirects")).toBeGreaterThan(0);
  });

  it("finishes a throttled reshard without errors", () => {
    const frame = runModel(model, params("throttled"), 20261110, 60);
    expect(metricValue(frame, "migration-progress")).toBe(100);
    expect(metricValue(frame, "request-errors")).toBe(0);
    expect(metricValue(frame, "source-cpu")).toBeLessThan(70);
  });

  it("splits request throughput across source and target", () => {
    const frame = runModel(model, params("failure"), 20261110, 5);
    const source = frame.nodes.find((node) => node.id === "source")?.throughput ?? 0;
    const target = frame.nodes.find((node) => node.id === "target")?.throughput ?? 0;
    const total = Number(params("failure").totalRps);
    const progress = metricValue(frame, "migration-progress") / 100;
    const targetEdge = frame.edges.find((item) => item.id === "cluster-target")?.rate ?? 0;
    expect(source + target).toBeCloseTo(total, 5);
    expect(targetEdge).toBeCloseTo((512 / 16_384) * progress, 6);
    expect(metricValue(frame, "ask-redirects")).toBeGreaterThan(0);
    expect(metricValue(runModel(model, params("failure"), 20261110, 20), "ask-redirects")).toBe(0);
  });

  it("labels the failure preset as starting healthy", () => {
    expect(preset("failure").description.toLowerCase()).toContain("starts healthy");
    const frame = applyPresetFrame(model, preset("failure"), 20261110);
    expect(metricValue(frame, "request-errors")).toBeLessThan(0.5);
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
      expect(stepped.metrics.find((other) => other.id === item.id)?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(meta.tags).toEqual(["MOVED", "ASK", "slot migration", "redirect", "client", "resharding"]);
    expect(model.params.length).toBe(5);
    expect(presets.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
