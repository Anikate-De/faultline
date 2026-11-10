import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { originShieldModel, module } from "./module";

const model = originShieldModel;
const presets = module.sims["origin-shield"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("traffic-origin-shield model", () => {
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

  it("loads the healthy preset with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metric(frame, "origin-burst")).toBeGreaterThan(15_000);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event and fires the expiry storm once", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "threshold-origin-burst-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "expiry-storm").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["origin-burst"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("per-edge collapsing reduces each edge to one fetch but leaves one per edge", () => {
    const collapseOnly = runModel(model, params("collapse-only"), 20261110, 10);
    expect(metric(collapseOnly, "origin-burst")).toBe(100);
    expect(metric(collapseOnly, "origin-rps")).toBeLessThan(5);
  });

  it("a shield reduces the origin burst to one and moves the fan-in to the shield", () => {
    const shieldOnly = runModel(model, params("shield-only"), 20261110, 10);
    expect(metric(shieldOnly, "origin-burst")).toBe(1);
    expect(metric(shieldOnly, "shield-inbound")).toBeGreaterThan(400);
    expect(metric(shieldOnly, "origin-rps")).toBeLessThan(1);
    expect(metric(shieldOnly, "p99")).toBeLessThan(300);
  });

  it("marks the origin node on a miss burst even when average utilization is low", () => {
    const frame = runModel(model, params("peak"), 20261110, 10);
    const origin = frame.nodes.find((node) => node.id === "origin");
    expect(origin?.health).toBe("warn");
  });

  it("shorter TTLs make the burst more frequent without changing its size", () => {
    const short = runModel(model, { ...params("collapse-only"), ttlSeconds: 15 }, 20261110, 10);
    const long = runModel(model, { ...params("collapse-only"), ttlSeconds: 300 }, 20261110, 10);
    expect(metric(short, "origin-burst")).toBe(metric(long, "origin-burst"));
    expect(metric(short, "origin-rps")).toBeGreaterThan(metric(long, "origin-rps"));
  });

  it("runs the experiment at the storm setup it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-shield");
    expect(experiment?.setup.shieldEnabled).toBe(0);
    expect(experiment?.setup.collapseEnabled).toBe(0);
    expect(experiment?.fix?.shieldEnabled).toBe(1);
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
    expect(model.params.length).toBe(5);
    expect(module.sims["origin-shield"].alternateVisuals).toContain("timeline");
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.experiments.length).toBe(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
