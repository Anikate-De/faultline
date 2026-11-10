import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, loadTestingModel } from "./module";

const model = loadTestingModel;
const presets = module.sims["load-testing"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;

describe("capacity-load-testing model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 45);
    const b = runModel(model, params("failure"), 42, 45);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative values", () => {
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
      for (const point of values) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "blind-spot")?.value).toBeGreaterThan(25);
    expect(frame.metrics.find((item) => item.id === "p99-corrected")?.value).toBeGreaterThan(800);
    expect(frame.metrics.find((item) => item.id === "p99-reported")?.value ?? 0).toBeLessThan(300);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the healthy preset ok and the near-knee preset at warning", () => {
    const healthy = runModel(model, params("healthy"), 20261110, 60);
    const peak = runModel(model, params("peak"), 20261110, 60);
    expect(activeThreshold(healthy, model.thresholds)).toBeNull();
    expect(activeThreshold(peak, model.thresholds)?.severity).toBe("warn");
  });

  it("shows a closed-loop test sending less than its intended arrival", () => {
    const closed = runModel(model, params("failure"), 20261110, 30);
    const open = runModel(model, { ...params("failure"), loopMode: 0 }, 20261110, 30);
    const achieved = (frame: typeof closed) => frame.metrics.find((item) => item.id === "achieved-rps")?.value ?? 0;
    const fidelity = (frame: typeof closed) => frame.metrics.find((item) => item.id === "arrival-fidelity")?.value ?? 0;
    expect(achieved(closed)).toBeLessThan(6_000);
    expect(fidelity(closed)).toBeLessThan(60);
    expect(fidelity(open)).toBe(100);
  });

  it("a slower dependency lowers capacity and raises latency", () => {
    const fast = runModel(model, { ...params("healthy"), targetRps: 6_500 }, 20261110, 30);
    const slow = runModel(model, { ...params("healthy"), targetRps: 6_500, dependencyLatencyMs: 250 }, 20261110, 30);
    const p99 = (frame: typeof fast) => frame.metrics.find((item) => item.id === "p99-corrected")?.value ?? 0;
    expect(p99(slow)).toBeGreaterThan(p99(fast));
    expect(activeThreshold(slow, model.thresholds)?.severity).toBe("crit");
  });

  it("keeps the first closed-loop gap event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const events = frame.events.filter((event) => event.id === "closed-loop-gap");
    expect(events.length).toBe(1);
    expect(events[0].severity).toBe("crit");
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
    expect(presets.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
