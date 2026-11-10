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
import { keysOrderingModel, module } from "./module";

const model = keysOrderingModel;
const presets = module.sims["keys-ordering"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("streaming-keys-ordering model", () => {
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
    expect(metricValue(frame, "out-of-order")).toBeGreaterThan(90);
    expect(frame.events.some((event) => event.id === "threshold-out-of-order-crit")).toBe(true);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "out-of-order")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-out-of-order-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("fires the split-event warning once per occurrence", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "split-sequences").length).toBe(1);
    expect(frame.flags.splitSeen).toBe(1);
  });

  it("an entity key removes the ordering risk", () => {
    const eventKeyed = runModel(model, params("failure"), 20261110, 20);
    const entityKeyed = runModel(model, { ...params("failure"), keyStrategy: 1 }, 20261110, 20);
    expect(metricValue(eventKeyed, "out-of-order")).toBeGreaterThan(90);
    expect(metricValue(entityKeyed, "out-of-order")).toBe(0);
    expect(metricValue(entityKeyed, "partition-load")).toBeLessThan(70);
  });

  it("a tenant key preserves order but skews the hottest partition", () => {
    const frame = runModel(model, params("tenant-key"), 20261110, 20);
    expect(metricValue(frame, "out-of-order")).toBe(0);
    expect(metricValue(frame, "partition-skew")).toBeGreaterThan(2);
    expect(metricValue(frame, "partition-load")).toBeGreaterThan(70);
    expect(frame.nodes.find((node) => node.id === "partition-hot")?.health).not.toBe("ok");
  });

  it("more related events widen the split risk for a non-entity key", () => {
    const three = runModel(model, { ...params("failure"), eventsPerOrder: 3 }, 20261110, 20);
    const eight = runModel(model, { ...params("failure"), eventsPerOrder: 8 }, 20261110, 20);
    expect(metricValue(eight, "out-of-order")).toBeGreaterThanOrEqual(
      metricValue(three, "out-of-order"),
    );
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
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "tenant-key"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
