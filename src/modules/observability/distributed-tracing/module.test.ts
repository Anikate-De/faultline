import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { distributedTracingModel, module } from "./module";

const model = distributedTracingModel;
const presets = module.sims["distributed-tracing"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-distributed-tracing model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "missing-spans")).toBe(0);
    expect(value(frame, "unattributed-latency")).toBe(0);
    expect(value(frame, "sampled-traces")).toBe(1000);
    expect(value(frame, "complete-traces")).toBe(1000);
    expect(value(frame, "trace-p99")).toBe(192);
    expect(frame.nodes.filter((node) => node.span)).toHaveLength(12);
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
    expect(value(frame, "missing-spans")).toBeGreaterThan(20);
    expect(value(frame, "unattributed-latency")).toBeGreaterThan(400);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "missing-spans")).toBe(0);
    expect(value(frame, "trace-p99")).toBeLessThan(500);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-missing-spans-crit");
    const custom = frame.events.filter((event) => event.id === "trace-context-lost");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(custom.length).toBe(1);
  });

  it("separates propagation from instrumentation", () => {
    const propagatedOnly = runModel(
      model,
      { ...params("peak"), propagationCoverage: 100, instrumentedServices: 100 },
      20261110,
      20,
    );
    const uninstrumented = runModel(
      model,
      { ...params("peak"), propagationCoverage: 100, instrumentedServices: 50 },
      20261110,
      20,
    );
    expect(value(propagatedOnly, "missing-spans")).toBe(0);
    expect(value(uninstrumented, "missing-spans")).toBe(50);
  });

  it("reports sampling separately from completeness", () => {
    const full = runModel(model, { ...params("healthy"), samplingRate: 100 }, 20261110, 20);
    const sampled = runModel(model, { ...params("healthy"), samplingRate: 5 }, 20261110, 20);
    expect(value(full, "missing-spans")).toBe(0);
    expect(value(sampled, "missing-spans")).toBe(0);
    expect(value(full, "sampled-traces")).toBe(1000);
    expect(value(sampled, "sampled-traces")).toBe(50);
    expect(value(sampled, "complete-traces")).toBe(50);
  });

  it("does not create a node incident just because spans are missing", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), propagationCoverage: 20, instrumentedServices: 100, samplingRate: 100 },
      20261110,
      20,
    );
    expect(value(frame, "missing-spans")).toBe(80);
    expect(value(frame, "sampled-traces")).toBe(1000);
    expect(value(frame, "complete-traces")).toBe(200);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(activeNodeIncident(frame)).toBeNull();
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
