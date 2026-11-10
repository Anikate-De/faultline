import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, wafShieldModel } from "./module";

const model = wafShieldModel;
const presets = module.sims["edge-defense"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("cloud-networking-waf-shield model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps every metric and series value finite and non-negative", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const series of Object.values(frame.series)) {
      for (const point of series) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
      }
    }
    for (const node of frame.nodes) {
      expect(node.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(node.utilization ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it("crosses critical within 30 simulated seconds when the residual flood saturates", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "origin-utilization")).toBeGreaterThan(95);
    expect(value(frame, "error-rate")).toBeGreaterThan(5);
    expect(frame.nodes.find((node) => node.id === "origin")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "origin-utilization")).toBeLessThan(80);
    expect(value(frame, "error-rate")).toBe(0);
  });

  it("keeps the origin at baseline for a volumetric flood", () => {
    const frame = runModel(model, params("volumetric"), 20261110, 30);
    expect(value(frame, "origin-utilization")).toBeLessThan(50);
    expect(value(frame, "blocked-rate")).toBe(100);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("leaves the peak state below critical", () => {
    const frame = runModel(model, params("peak"), 20261110, 30);
    expect(value(frame, "origin-utilization")).toBeGreaterThanOrEqual(80);
    expect(value(frame, "origin-utilization")).toBeLessThan(95);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("deduplicates the saturation event", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-error-rate-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "origin-saturated").length).toBe(1);
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
    expect(model.params.length).toBeGreaterThanOrEqual(3);
    expect(model.params.length).toBeLessThanOrEqual(6);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
  });
});
