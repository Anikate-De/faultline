import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, timelineModel } from "./module";

const model = timelineModel;
const presets = module.sims.timeline.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-incident-timeline model", () => {
  it("is deterministic for the same seed and parameters", () => {
    expect(JSON.stringify(runModel(model, params("failure"), 42, 20))).toBe(
      JSON.stringify(runModel(model, params("failure"), 42, 20)),
    );
  });

  it("keeps every metric finite, non-negative, and utilization bounded", () => {
    const frame = runModel(model, params("failure"), 7, 40);
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
    expect(metric(frame, "blamed-deploy")).toBe(0);
  });

  it("crosses the blame threshold in the skewed deploy failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metric(frame, "clock-offset")).toBe(180);
    expect(metric(frame, "misordered-pairs")).toBeGreaterThanOrEqual(2);
    expect(metric(frame, "blamed-deploy")).toBe(1);
  });

  it("returns to ok within 60 simulated seconds of the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metric(frame, "blamed-deploy")).toBe(0);
  });

  it("shows the deploy annotation after the error onset only when the clock is skewed", () => {
    const skewed = runModel(model, params("failure"), 20261110, 5);
    const deploy = skewed.events.find((event) => event.id === "tl-deploy");
    const error = skewed.events.find((event) => event.id === "tl-error");
    expect(deploy?.at ?? 0).toBeGreaterThan(error?.at ?? 0);

    const clean = runModel(model, params("healthy"), 20261110, 5);
    const cleanDeploy = clean.events.find((event) => event.id === "tl-deploy");
    const cleanError = clean.events.find((event) => event.id === "tl-error");
    expect(cleanDeploy?.at ?? 0).toBeLessThan(cleanError?.at ?? 0);
  });

  it("marks a missing deploy marker as an unattributed change", () => {
    const frame = runModel(model, params("missing-marker"), 20261110, 10);
    expect(metric(frame, "unattributed-change")).toBe(1);
    expect(frame.events.some((event) => event.id === "tl-missing-deploy")).toBe(true);
  });

  it("keeps only the reconstructed timeline events in the replay", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.every((event) => event.id.startsWith("tl-"))).toBe(true);
    expect(frame.events.filter((event) => event.id === "tl-error").length).toBe(1);
    expect(frame.events.length).toBe(7);
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
