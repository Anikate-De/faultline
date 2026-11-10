import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, poisonMessagesModel } from "./module";

const model = poisonMessagesModel;
const presets = module.sims["poison-messages"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (id: string, seconds: number, presetId = "failure") =>
  runModel(model, params(presetId), 20261110, seconds).metrics.find((item) => item.id === id)?.value ?? 0;

describe("streaming-poison-messages model", () => {
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
    expect(frame.metrics.find((item) => item.id === "queueDepth")?.value).toBeGreaterThan(10_000);
    expect(frame.metrics.find((item) => item.id === "partition-throughput")?.value).toBe(0);
    expect(frame.flags.stalled).toBe(1);
  });

  it("returns to ok within 60 seconds on the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.metrics.find((item) => item.id === "queueDepth")?.value).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const stalled = frame.events.filter((event) => event.id === "partition-stalled");
    expect(stalled.length).toBe(1);
    expect(stalled[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "poison-record-blocking").length).toBe(1);
  });

  it("quarantine moves the failure to the DLQ while the partition keeps up", () => {
    const frame = runModel(model, params("skip"), 20261110, 60);
    expect(frame.metrics.find((item) => item.id === "queueDepth")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "dlq-depth")?.value).toBeGreaterThan(100);
    expect(frame.flags.stalled).toBe(0);
  });

  it("reports metrics that agree with node state", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const topic = frame.nodes.find((node) => node.id === "topic");
    expect(frame.metrics.find((item) => item.id === "queueDepth")?.value).toBeCloseTo(Number(topic?.meta?.depth ?? 0), 5);
    const consumer = frame.nodes.find((node) => node.id === "consumer");
    expect(frame.metrics.find((item) => item.id === "partition-throughput")?.value).toBeCloseTo(consumer?.throughput ?? 0, 5);
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
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "skip"]),
    );
    expect(metricValue("dlq-depth", 60, "skip")).toBeGreaterThan(0);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
