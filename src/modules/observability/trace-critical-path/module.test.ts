import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { traceCriticalPathModel, module } from "./module";

const model = traceCriticalPathModel;
const presets = module.sims["trace-critical-path"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-trace-critical-path model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "critical-path")).toBe(265);
    expect(frame.nodes.filter((node) => node.span)).toHaveLength(8);
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
    for (const series of Object.values(frame.series)) {
      for (const item of series) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "critical-path")).toBeGreaterThan(800);
    expect(value(frame, "wait-share")).toBeGreaterThan(65);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "critical-path")).toBeLessThan(400);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-critical-path-crit");
    const custom = frame.events.filter((event) => event.id === "critical-path-wait");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(custom.length).toBe(1);
  });

  it("shows that the longest span is not always on the critical path", () => {
    const base = runModel(model, params("healthy"), 20261110, 20);
    const longAsync = runModel(
      model,
      { ...params("healthy"), asyncWorkMs: 900 },
      20261110,
      20,
    );
    expect(value(longAsync, "critical-path")).toBeCloseTo(value(base, "critical-path"), 6);
    expect(value(longAsync, "async-work")).toBe(900);
    expect(value(base, "async-work")).toBeLessThan(value(longAsync, "async-work"));
    expect(activeThreshold(longAsync, model.thresholds)).toBeNull();
  });

  it("shows that removing the wait lowers the path", () => {
    const failure = runModel(model, params("failure"), 20261110, 20);
    const fixed = runModel(
      model,
      { ...params("failure"), dependencyWaitMs: 100 },
      20261110,
      20,
    );
    expect(value(fixed, "critical-path")).toBeLessThan(value(failure, "critical-path") - 500);
    expect(value(fixed, "async-work")).toBe(900);
    expect(value(fixed, "slowest-branch")).toBe(160);
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
