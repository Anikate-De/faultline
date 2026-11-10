import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, subprocessorsModel } from "./module";

const model = subprocessorsModel;
const presets = module.sims["subprocessors"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("compliance-subprocessors model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "inventory-gap")).toBe(0);
    expect(value(frame, "notice-shortfall")).toBe(0);
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
    expect(value(frame, "inventory-gap")).toBeGreaterThanOrEqual(40);
    expect(value(frame, "flow-down-gap")).toBeGreaterThanOrEqual(40);
    expect(value(frame, "notice-shortfall")).toBeGreaterThanOrEqual(15);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const custom = frame.events.filter((event) => event.id === "unapproved-subprocessor");
    expect(custom.length).toBe(1);
    expect(custom[0].severity).toBe("crit");
  });

  it("derives the critical event from the largest chain gap", () => {
    const frame = runModel(
      model,
      { inventoryCoverage: 100, flowDownCoverage: 0, noticeDays: 60 },
      20261110,
      20,
    );
    const event = frame.events.find((item) => item.id === "unapproved-subprocessor");
    expect(event?.metricId).toBe("flow-down-gap");
    expect(event?.nodeId).toBe("terms");
    expect(event?.title).toBe("Equivalent obligations do not follow the data");
  });

  it("does not treat a disclosed subprocessor as an approved one", () => {
    const frame = runModel(
      model,
      { inventoryCoverage: 100, flowDownCoverage: 0, noticeDays: 0 },
      20261110,
      20,
    );
    expect(value(frame, "inventory-gap")).toBe(0);
    expect(value(frame, "flow-down-gap")).toBe(100);
    expect(value(frame, "unapproved-exposure")).toBe(100);
    expect(frame.nodes.find((node) => node.id === "subprocessor")?.health).toBe("crit");
  });

  it("marks the region promise critical when the chain leaves the approved path", () => {
    const frame = runModel(model, module.experiments[0].setup, 20261110, 20);
    expect(value(frame, "notice-shortfall")).toBe(20);
    expect(value(frame, "unapproved-exposure")).toBeGreaterThanOrEqual(50);
    expect(frame.nodes.find((node) => node.id === "region")?.health).toBe("crit");
  });

  it("restores the chain when terms and notice cover the change", () => {
    const frame = runModel(model, { ...module.experiments[0].fix }, 20261110, 20);
    expect(value(frame, "unapproved-exposure")).toBe(0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
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
      const other = stepped.metrics.find((metricValue) => metricValue.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
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
