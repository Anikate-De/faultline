import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { burnRateModel, module } from "./module";

const model = burnRateModel;
const presets = module.sims.burn.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-slo-burn-rate model", () => {
  it("is deterministic for the same seed and parameters", () => {
    expect(JSON.stringify(runModel(model, params("failure"), 42, 45))).toBe(
      JSON.stringify(runModel(model, params("failure"), 42, 45)),
    );
  });

  it("keeps every metric finite, non-negative, and utilization bounded", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const node of frame.nodes) {
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

  it("loads the healthy preset at ok with no active threshold", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
    expect(metric(frame, "page-decision")).toBe(0);
  });

  it("crosses the multi-window threshold within 30 simulated seconds of the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metric(frame, "fast-burn")).toBeCloseTo(15, 1);
    expect(metric(frame, "slow-burn")).toBeCloseTo(15, 1);
    expect(metric(frame, "page-decision")).toBe(1);
    expect(metric(frame, "mtd-slo")).toBeGreaterThan(99.9);
  });

  it("keeps the static 2% error alert silent at 1.5% bad events", () => {
    const frame = runModel(model, params("failure"), 20261110, 45);
    expect(metric(frame, "error-rate")).toBeCloseTo(1.5, 2);
    expect(frame.events.some((event) => event.id === "static-error-alert")).toBe(false);
    expect(frame.events.some((event) => event.id === "multi-window-page")).toBe(true);
  });

  it("returns to ok within 60 simulated seconds of the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metric(frame, "page-decision")).toBe(0);
  });

  it("keeps the first critical page event during deduplication", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const pages = frame.events.filter((event) => event.id === "multi-window-page");
    expect(pages.length).toBe(1);
    expect(pages[0].severity).toBe("crit");
  });

  it("does not page while only the fast window has crossed", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    expect(metric(frame, "fast-burn")).toBeGreaterThan(14);
    expect(metric(frame, "slow-burn")).toBeLessThan(14);
    expect(metric(frame, "page-decision")).toBe(0);
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
