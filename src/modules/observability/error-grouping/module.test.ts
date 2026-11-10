import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { errorGroupingModel, module } from "./module";

const model = errorGroupingModel;
const presets = module.sims["error-grouping"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-error-grouping model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "visibility-shortfall")).toBe(0);
    expect(value(frame, "group-count")).toBe(3);
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
    for (const series of Object.values(frame.series)) {
      for (const item of series) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "visibility-shortfall")).toBeGreaterThan(40);
    expect(value(frame, "largest-group-share")).toBeGreaterThan(85);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "visibility-shortfall")).toBe(0);
    expect(value(frame, "triage-time")).toBeLessThan(20);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-visibility-shortfall-crit");
    const custom = frame.events.filter((event) => event.id === "error-class-buried");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(custom.length).toBe(1);
  });

  it("does not report an incident for a single cause in a single group", () => {
    const frame = runModel(model, { ...params("healthy"), distinctCauses: 1 }, 20261110, 20);
    const largest = frame.metrics.find((item) => item.id === "largest-group-share");
    expect(largest?.value).toBe(100);
    expect(largest?.warn).toBeUndefined();
    expect(value(frame, "group-concentration")).toBe(0);
    expect(value(frame, "visibility-shortfall")).toBe(0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("splits causes as fingerprint specificity rises", () => {
    const generic = runModel(model, { ...params("healthy"), fingerprintSpecificity: 20 }, 20261110, 20);
    const specific = runModel(model, { ...params("healthy"), fingerprintSpecificity: 95 }, 20261110, 20);
    expect(value(generic, "group-count")).toBe(1);
    expect(value(specific, "group-count")).toBe(3);
    expect(value(specific, "visibility-shortfall")).toBeLessThan(value(generic, "visibility-shortfall"));
  });

  it("keeps volume separate from grouping quality", () => {
    const quiet = runModel(model, { ...params("failure"), eventVolume: 100 }, 20261110, 20);
    const loud = runModel(model, { ...params("failure"), eventVolume: 200_000 }, 20261110, 20);
    expect(value(quiet, "group-count")).toBe(value(loud, "group-count"));
    expect(value(quiet, "visibility-shortfall")).toBeCloseTo(value(loud, "visibility-shortfall"), 5);
    expect(value(quiet, "triage-time")).toBeCloseTo(value(loud, "triage-time"), 5);
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
