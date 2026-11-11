import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, statefulsetModel } from "./module";

const model = statefulsetModel;
const presets = module.sims.statefulsets.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("kubernetes-statefulsets model", () => {
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
      for (const item of values) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("starts healthy with no active threshold", () => {
    const frame = runModel(model, params("healthy"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "lost-ordinals")).toBe(0);
  });

  it("loses data on every ordinal when emptyDir is recreated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "lost-ordinals")).toBe(3);
    expect(value(frame, "pods-at-risk")).toBe(3);
    expect(value(frame, "available-ordinals")).toBe(0);
    expect(value(frame, "bound-claims")).toBe(0);
  });

  it("keeps the ordinal but loses one claim when the PVC is deleted", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "lost-ordinals")).toBe(1);
    expect(value(frame, "available-ordinals")).toBe(2);
    expect(value(frame, "bound-claims")).toBe(2);
  });

  it("reattaches the claim after a node failure", () => {
    const frame = runModel(model, params("reattach"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "lost-ordinals")).toBe(0);
    expect(value(frame, "available-ordinals")).toBe(2);
    expect(value(frame, "bound-claims")).toBe(3);
  });

  it("returns to ok within 60 seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "lost-ordinals")).toBe(0);
    expect(value(frame, "available-ordinals")).toBe(5);
    expect(value(frame, "ordinal-availability")).toBe(100);
    expect(frame.nodes.filter((node) => node.id.startsWith("pod-") && node.health === "down")).toHaveLength(0);
  });

  it("reports the same claim name on each ordinal", () => {
    const frame = runModel(model, params("healthy"), 20261110, 20);
    const pods = frame.nodes.filter((node) => node.id.startsWith("pod-"));
    expect(pods).toHaveLength(3);
    for (const [index, pod] of pods.entries()) {
      expect(pod.sublabel).toContain(`data-pod-${index}`);
    }
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-lost-ordinals-crit");
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe("crit");
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
    expect(model.params).toHaveLength(4);
    expect(presets).toHaveLength(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
    const experiment = module.experiments[0];
    expect(experiment.prediction.options.some((option) => option.id === experiment.prediction.correctOptionId)).toBe(true);
  });
});
