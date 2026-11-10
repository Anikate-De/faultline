import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { loadSheddingModel, module } from "./module";

const model = loadSheddingModel;
const presets = module.sims["load-shedding"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("foundations-load-shedding model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative utilization", () => {
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
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "p99")).toBeGreaterThan(2_000);
    expect(metricValue(frame, "goodput")).toBeLessThan(2_000);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "high-priority-rejection")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-p99-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("early shedding raises goodput and lowers queue delay", () => {
    const failure = runModel(model, params("failure"), 20261110, 30);
    const shed = runModel(model, params("early-shed"), 20261110, 30);
    expect(metricValue(shed, "goodput")).toBeGreaterThan(metricValue(failure, "goodput"));
    expect(metricValue(shed, "queue-delay")).toBeLessThan(metricValue(failure, "queue-delay"));
    expect(metricValue(shed, "high-priority-rejection")).toBe(0);
  });

  it("stays stable through the recovery window", () => {
    const samples = [30, 60, 90, 120].map((seconds) =>
      runModel(model, params("recovery"), 20261110, seconds),
    );
    const p99s = samples.map((frame) => metricValue(frame, "p99"));
    expect(Math.max(...p99s)).toBeLessThan(400);
    expect(Math.max(...p99s) - Math.min(...p99s)).toBeLessThan(200);
    for (const frame of samples) {
      expect(activeThreshold(frame, model.thresholds)).toBeNull();
    }
  });

  it("reports an admitted rate on the queue node, not queue depth", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    const throughput = frame.nodes.find((node) => node.id === "admission")?.throughput ?? 0;
    expect(throughput).toBeGreaterThan(0);
    expect(throughput).toBeLessThanOrEqual(10_000);
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
    expect(model.params.length).toBeGreaterThanOrEqual(3);
    expect(model.params.length).toBeLessThanOrEqual(6);
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
