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
import { consumerGroupsModel, module } from "./module";

const model = consumerGroupsModel;
const presets = module.sims["consumer-groups"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("streaming-consumer-groups model", () => {
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
    expect(metricValue(frame, "replay-risk")).toBe(30_000);
    expect(metricValue(frame, "commit-age")).toBe(30);
    expect(frame.events.some((event) => event.id === "threshold-replay-risk-crit")).toBe(true);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "replay-risk")).toBeLessThan(5_000);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-replay-risk-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("records each group restart once and replays only after the first restart", () => {
    const before = runModel(model, params("failure"), 20261110, 7);
    expect(metricValue(before, "replayed-events")).toBe(0);
    const after = runModel(model, params("failure"), 20261110, 60);
    const restarts = after.events.filter((event) => event.id.startsWith("group-restart-"));
    expect(new Set(restarts.map((event) => event.id)).size).toBe(restarts.length);
    expect(restarts.length).toBeGreaterThanOrEqual(2);
    expect(restarts[0].title).toContain("consumer group");
    expect(restarts[0].nodeId).toBe("group");
    expect(metricValue(after, "replayed-events")).toBeGreaterThan(30_000);
  });

  it("computes the replay window for the whole group, not one member", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(metricValue(frame, "consume-rate")).toBe(1_000);
    expect(metricValue(frame, "replay-risk")).toBe(30_000);
    expect(metricValue(frame, "replay-risk")).toBe(
      metricValue(frame, "consume-rate") * 30,
    );
  });

  it("scales the replay window with the commit interval", () => {
    const short = runModel(model, { ...params("failure"), commitInterval: 1 }, 20261110, 20);
    const long = runModel(model, { ...params("failure"), commitInterval: 30 }, 20261110, 20);
    expect(metricValue(long, "replay-risk")).toBe(30 * metricValue(short, "replay-risk"));
  });

  it("derives processed rate from members and processing time", () => {
    const frame = runModel(model, params("failure"), 20261110, 5);
    expect(metricValue(frame, "consume-rate")).toBeCloseTo((10 * 1000) / 10, 5);
    const slower = runModel(model, { ...params("failure"), processingMs: 40 }, 20261110, 5);
    expect(metricValue(slower, "consume-rate")).toBeCloseTo(10 * 25, 5);
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
    expect(presets.length).toBe(4);
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
