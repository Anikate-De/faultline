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
import { partitionCountModel, module } from "./module";

const model = partitionCountModel;
const presets = module.sims["partition-count"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("streaming-partition-count model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    const presetFrame = applyPresetFrame(model, preset("healthy"), 20261110);
    expect(activeThreshold(presetFrame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(presetFrame)).toBeNull();
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

  it("crosses warning and critical within 30 simulated seconds", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "controller-failover")).toBeGreaterThan(100);
    expect(metricValue(frame, "file-handles")).toBe(2_400);
    expect(frame.events.some((event) => event.id === "threshold-controller-failover-crit")).toBe(true);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "controller-failover")).toBeLessThan(20);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-controller-failover-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("fires the controller election event once per active failover", () => {
    const frame = runModel(model, params("two-hundred"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "controller-election").length).toBe(1);
    expect(frame.flags.failoverSeen).toBe(1);
    const steady = runModel(model, params("healthy"), 20261110, 20);
    expect(steady.flags.failoverSeen).toBe(0);
  });

  it("partition count raises recovery cost without raising broker CPU", () => {
    const small = runModel(model, { ...params("healthy"), partitionCount: 48 }, 20261110, 10);
    const large = runModel(model, { ...params("healthy"), partitionCount: 240 }, 20261110, 10);
    expect(metricValue(large, "controller-failover")).toBeGreaterThan(
      metricValue(small, "controller-failover"),
    );
    expect(metricValue(large, "file-handles")).toBeGreaterThan(metricValue(small, "file-handles"));
    expect(metricValue(large, "broker-cpu")).toBe(metricValue(small, "broker-cpu"));
  });

  it("spreading the same partitions over more brokers reduces recovery cost", () => {
    const three = runModel(model, { ...params("healthy"), partitionCount: 240, brokerCount: 3 }, 20261110, 10);
    const twelve = runModel(model, { ...params("healthy"), partitionCount: 240, brokerCount: 12 }, 20261110, 10);
    expect(metricValue(twelve, "controller-failover")).toBeLessThan(
      metricValue(three, "controller-failover"),
    );
    expect(metricValue(twelve, "file-handles")).toBeLessThan(metricValue(three, "file-handles"));
  });

  it("keeps the experiment setup consistent with the 400-partition claims", () => {
    const setup = module.experiments[0].setup;
    const frame = runModel(model, setup, 20261110, 20);
    expect(metricValue(frame, "controller-failover")).toBeGreaterThan(100);
    expect(metricValue(frame, "file-handles")).toBe(2_400);
    expect(metricValue(frame, "rebalance-time")).toBeGreaterThan(35);
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
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "two-hundred"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
