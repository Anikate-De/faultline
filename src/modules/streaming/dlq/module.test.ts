import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { dlqModel, module } from "./module";

const model = dlqModel;
const presets = module.sims.dlq.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (id: string, seconds: number, presetId = "failure") =>
  runModel(model, params(presetId), 20261110, seconds).metrics.find((item) => item.id === id)?.value ?? 0;

describe("streaming-dlq model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 45);
    const b = runModel(model, params("failure"), 42, 45);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold", () => {
    const frame = runModel(model, params("healthy"), 20261110, 0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    for (const node of frame.nodes) expect(node.health).toBe("ok");
  });

  it("never reports NaN, Infinity, or out-of-range utilization", () => {
    const frame = runModel(model, params("failure"), 7, 90);
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

  it("crosses critical within 60 seconds on the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "queueDepth")?.value).toBeGreaterThan(25_000);
    expect(frame.metrics.find((item) => item.id === "time-to-alert")?.value).toBe(86_400);
  });

  it("returns to ok within 60 seconds on the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.metrics.find((item) => item.id === "queueDepth")?.value).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "dlq-unnoticed").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "threshold-queueDepth-crit").length).toBe(1);
  });

  it("alerting alone does not drain the queue", () => {
    const frame = runModel(model, params("alert-only"), 20261110, 60);
    expect(frame.metrics.find((item) => item.id === "time-to-alert")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "queueDepth")?.value).toBeGreaterThan(25_000);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("replay outruns failures and protects retention", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(frame.metrics.find((item) => item.id === "queueDepth")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "at-risk-records")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "retention-ratio")?.value).toBe(0);
  });

  it("reports metrics that agree with node state", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const dlq = frame.nodes.find((node) => node.id === "dlq");
    expect(frame.metrics.find((item) => item.id === "queueDepth")?.value).toBeCloseTo(Number(dlq?.meta?.depth ?? 0), 5);
    expect(frame.flags.seed).toBe(20261110);
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
    expect(presets.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "alert-only"]),
    );
    expect(metricValue("queueDepth", 60, "recovery")).toBe(0);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
