import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { anomalyModel, module } from "./module";

const model = anomalyModel;
const presets = module.sims.anomaly.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-anomaly-detection model", () => {
  it("is deterministic for the same seed and parameters", () => {
    expect(JSON.stringify(runModel(model, params("failure"), 42, 120))).toBe(
      JSON.stringify(runModel(model, params("failure"), 42, 120)),
    );
  });

  it("keeps every metric finite, non-negative, and utilization bounded", () => {
    const frame = runModel(model, params("failure"), 7, 130);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const node of frame.nodes) {
      expect(node.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(node.utilization ?? 0).toBeLessThanOrEqual(1);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it("loads the healthy preset at ok with no active threshold", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
    expect(metric(frame, "false-positive-pages")).toBe(0);
  });

  it("crosses the false-positive threshold in the short-baseline failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metric(frame, "false-positive-pages")).toBeGreaterThanOrEqual(6);
    expect(metric(frame, "coverage-shortfall")).toBeGreaterThan(25);
  });

  it("pages on the normal weekly peak with a short baseline", () => {
    const frame = runModel(model, params("peak"), 20261110, 10);
    expect(metric(frame, "false-positive-pages")).toBeGreaterThanOrEqual(4);
    expect(metric(frame, "false-positive-pages")).toBeLessThan(6);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("keeps the weekly false-positive rate at the end of the 120-second experiment", () => {
    const frame = runModel(model, params("peak"), 20261110, 120);
    expect(metric(frame, "false-positive-pages")).toBe(5);
  });

  it("returns to ok within 60 simulated seconds of the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metric(frame, "false-positive-pages")).toBe(0);
  });

  it("includes a real incident in the score and pager state at 100 seconds", () => {
    const frame = runModel(model, params("healthy"), 20261110, 100);
    expect(metric(frame, "anomaly-score")).toBeGreaterThan(3);
    expect(metric(frame, "real-anomaly-page")).toBe(1);
    expect(metric(frame, "detector-pages")).toBe(1);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.nodes.find((node) => node.id === "pager")?.health).toBe("crit");
  });

  it("detects the real incident at three sigma and misses it at six sigma", () => {
    const detected = runModel(model, params("peak"), 20261110, 120);
    expect(detected.events.some((event) => event.id === "real-anomaly-detected")).toBe(true);
    expect(metric(detected, "missed-detections")).toBe(0);

    const missed = runModel(model, params("numb"), 20261110, 120);
    expect(metric(missed, "missed-detections")).toBe(1);
    expect(missed.events.some((event) => event.id === "real-anomaly-missed")).toBe(true);
  });

  it("keeps the first false-positive event during deduplication", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "seasonal-false-page").length).toBe(1);
  });

  it("runFor matches stepping the same number of ticks", () => {
    const seconds = 12;
    const fast = runModel(model, params("peak"), 99, seconds);
    let stepped = initModel(model, params("peak"), 99);
    const rng = createRng(99);
    for (let index = 0; index < seconds / TICK; index++) {
      stepped = stepModel(model, stepped, params("peak"), rng);
    }
    expect(stepped.t).toBeCloseTo(fast.t, 5);
    for (const item of fast.metrics) {
      expect(stepped.metrics.find((other) => other.id === item.id)?.value).toBeCloseTo(item.value, 6);
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
