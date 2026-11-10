import { describe, expect, it } from "vitest";
import {
  activeNodeIncident,
  activeThreshold,
  applyPresetFrame,
  initModel,
  runModel,
  stepModel,
  TICK,
} from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, postmortemModel } from "./module";

const model = postmortemModel;
const presets = module.sims.postmortems.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("reliability-blameless-postmortems model", () => {
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
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("loads healthy with no active threshold or failing node at t=0", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "evidence-gap")).toBeGreaterThanOrEqual(4);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

it("failure preset is critical immediately after applying it", () => {
    const failure = preset("failure");
    expect(failure.elapsed).toBeGreaterThan(0);
    const frame = applyPresetFrame(model, failure, 20261110);
    expect(frame.t).toBeCloseTo(failure.elapsed ?? 0, 3);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("reports review progress against the review window", () => {
    const frame = runModel(model, params("recovery"), 20261110, 21);
    expect(metricValue(frame, "review-progress")).toBe(100);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-blame-index-crit");
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("systemic framing increases shared facts and reduces recurrence risk", () => {
    const blameful = runModel(model, params("failure"), 20261110, 30);
    const systemic = runModel(model, params("recovery"), 20261110, 30);
    expect(metricValue(systemic, "factors-shared")).toBeGreaterThan(
      metricValue(blameful, "factors-shared"),
    );
    expect(metricValue(systemic, "recurrence-risk")).toBeLessThan(
      metricValue(blameful, "recurrence-risk"),
    );
  });

  it("a broader factor list reduces the evidence gap", () => {
    const narrow = runModel(model, params("failure"), 20261110, 30);
    const broad = runModel(
      model,
      { ...params("failure"), factorBreadth: 8 },
      20261110,
      30,
    );
    expect(metricValue(broad, "evidence-gap")).toBeLessThan(metricValue(narrow, "evidence-gap"));
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
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
    expect(module.experiments[0]?.simId).toBe("postmortems");
  });
});
