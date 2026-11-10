import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { piiRedactionModel, module } from "./module";

const model = piiRedactionModel;
const presets = module.sims["pii-redaction"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-pii-redaction model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "unredacted-fields")).toBe(0);
    expect(value(frame, "retained-fields")).toBe(0);
    expect(value(frame, "existing-copies")).toBe(0);
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
    expect(value(frame, "unredacted-fields")).toBeGreaterThan(20);
    expect(value(frame, "retained-fields")).toBeGreaterThan(50);
    expect(value(frame, "existing-copies")).toBeGreaterThan(2_000);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "leaked-fields")).toBe(0);
    expect(value(frame, "retained-fields")).toBe(0);
    expect(value(frame, "existing-copies")).toBeGreaterThan(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-unredacted-fields-crit");
    const custom = frame.events.filter((event) => event.id === "sensitive-fields-retained");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(custom.length).toBe(1);
  });

  it("separates new retention from existing copies", () => {
    const short = runModel(model, params("failure"), 20261110, 20);
    const long = runModel(
      model,
      { ...params("failure"), retentionDays: 365 },
      20261110,
      20,
    );
    expect(value(long, "existing-copies")).toBeGreaterThan(value(short, "existing-copies"));
    expect(value(long, "retained-fields")).toBeCloseTo(value(short, "retained-fields"), 5);
    expect(value(long, "leaked-fields")).toBeCloseTo(value(short, "leaked-fields"), 5);
  });

  it("keeps existing copies after the leak is stopped", () => {
    const experiment = module.experiments[0];
    const leaked = runModel(model, { ...experiment.setup }, 20261110, 20);
    const fixed = runModel(model, { ...experiment.setup, ...experiment.fix }, 20261110, 20);
    expect(value(fixed, "retained-fields")).toBe(0);
    expect(value(fixed, "existing-copies")).toBeGreaterThan(0);
    expect(value(fixed, "existing-copies")).toBeLessThan(value(leaked, "existing-copies"));
    expect(activeThreshold(fixed, model.thresholds)).toBeNull();
  });

  it("separates leak rate from detection coverage", () => {
    const experiment = module.experiments[0];
    const leaked = runModel(model, { ...experiment.setup }, 20261110, 20);
    const verified = runModel(
      model,
      { ...experiment.setup, auditCoverage: 100 },
      20261110,
      20,
    );
    expect(value(leaked, "audit-gap")).toBeGreaterThan(50);
    expect(value(verified, "audit-gap")).toBe(0);
    expect(value(verified, "leaked-fields")).toBeCloseTo(value(leaked, "leaked-fields"), 5);
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
    expect(model.params.length).toBe(5);
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
