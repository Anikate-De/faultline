import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, retryModel } from "./module";

const model = retryModel;
const sim = module.sims.retry;
const preset = (id: string) => {
  const found = sim.presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("mesh-retries model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts the healthy preset with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
    expect(value(frame, "amplification")).toBeCloseTo(1, 5);
    expect(value(frame, "error-rate")).toBe(0);
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

  it("crosses the critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "amplification")).toBeGreaterThan(2.5);
    expect(value(frame, "dep-util")).toBeGreaterThan(90);
    expect(value(frame, "error-rate")).toBeGreaterThan(5);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "amplification")).toBeLessThan(1.2);
    expect(value(frame, "dep-util")).toBeLessThan(60);
    expect(value(frame, "error-rate")).toBeLessThan(1);
  });

  it("warns without amplifying in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "amplification")).toBeCloseTo(1, 5);
    expect(value(frame, "dep-util")).toBeGreaterThan(75);
    expect(value(frame, "dep-util")).toBeLessThan(90);
  });

  it("a tight per-try timeout creates retries without a dependency fault", () => {
    const frame = runModel(model, params("tight-timeout"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "amplification")).toBeGreaterThan(2.5);
    expect(value(frame, "error-rate")).toBeGreaterThan(5);
    expect(frame.events.some((event) => event.id === "retry-fault")).toBe(false);
  });

  it("a retry budget keeps offered load below dependency capacity", () => {
    const storm = runModel(model, params("failure"), 20261110, 30);
    const bounded = runModel(model, params("recovery"), 20261110, 30);
    expect(value(bounded, "amplification")).toBeLessThan(1.2);
    expect(value(bounded, "dep-util")).toBeLessThan(75);
    expect(value(bounded, "amplification")).toBeLessThan(value(storm, "amplification"));
  });

  it("deduplicates retry events", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "retry-fault").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "retry-amplification").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "retry-prevents-recovery").length).toBe(1);
    const recovered = runModel(model, params("recovery"), 20261110, 60);
    expect(recovered.events.filter((event) => event.id === "retry-recovered").length).toBe(1);
  });

  it("keeps metric series history for sparklines and charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    expect(frame.series["amplification"]?.length).toBeGreaterThan(1);
    expect(frame.metrics.find((item) => item.id === "amplification")?.trend?.length).toBeGreaterThan(1);
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
      const other = stepped.metrics.find((entry) => entry.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBe(5);
    expect(sim.presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(sim.presets.length).toBe(5);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
