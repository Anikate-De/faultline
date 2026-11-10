import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { incidentNotificationModel, module } from "./module";

const model = incidentNotificationModel;
const presets = module.sims["incident-notification"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("compliance-incident-notification model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 60);
    const b = runModel(model, params("failure"), 42, 60);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "notification-lag")).toBe(22);
    expect(value(frame, "deadline-overrun")).toBe(0);
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
    expect(value(frame, "deadline-overrun")).toBe(54);
    expect(value(frame, "notification-lag")).toBe(78);
    expect(frame.nodes.find((node) => node.id === "clock")?.health).toBe("crit");
  });

  it("does not report a deadline overrun before the configured deadline arrives", () => {
    const frame = runModel(model, params("failure"), 20261110, 8);
    expect(value(frame, "deadline-overrun")).toBe(0);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "deadline-overrun")).toBe(0);
    expect(frame.nodes.find((node) => node.id === "clock")?.health).toBe("ok");
  });

  it("keeps each timeline event once when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    for (const id of ["suspected-incident", "legal-engaged", "notification-deadline", "notification-decision"]) {
      expect(frame.events.filter((event) => event.id === id).length).toBe(1);
    }
  });

  it("records the decision late when the team waits for certainty", () => {
    const frame = runModel(model, module.experiments[0].setup, 20261110, 50);
    expect(value(frame, "notification-lag")).toBe(80);
    expect(value(frame, "projected-overrun")).toBe(56);
    expect(value(frame, "deadline-overrun")).toBe(56);
    const decision = frame.events.find((event) => event.id === "notification-decision");
    expect(decision?.severity).toBe("crit");
  });

  it("records the decision before the deadline when legal is engaged early", () => {
    const frame = runModel(model, { ...module.experiments[0].fix }, 20261110, 20);
    const decision = frame.events.find((event) => event.id === "notification-decision");
    expect(decision?.severity).toBe("info");
    expect(value(frame, "deadline-overrun")).toBe(0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("runFor matches stepping the same number of ticks", () => {
    const seconds = 40;
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
    expect(stepped.events.map((event) => event.id)).toEqual(fast.events.map((event) => event.id));
  });

  it("uses the configured deadline rather than a hardcoded value", () => {
    const strict = runModel(model, { deadlineHours: 24, detectionHours: 8, decisionHours: 70 }, 20261110, 60);
    const relaxed = runModel(model, { deadlineHours: 72, detectionHours: 8, decisionHours: 70 }, 20261110, 60);
    expect(value(strict, "projected-overrun")).toBe(54);
    expect(value(relaxed, "projected-overrun")).toBe(6);
    expect(value(strict, "deadline-overrun")).toBe(54);
    expect(value(relaxed, "deadline-overrun")).toBe(6);
  });

  it("ships the 24, 72, and 1440-hour presets", () => {
    expect(params("healthy").deadlineHours).toBe(72);
    expect(params("peak").deadlineHours).toBe(24);
    expect(params("failure").deadlineHours).toBe(24);
    expect(params("recovery").deadlineHours).toBe(1440);
  });

  it("shows the failure preset already past the deadline when applied", () => {
    const failure = preset("failure");
    expect(failure.elapsed).toBe(40);
    let frame = initModel(model, failure.params, 20261110);
    const rng = createRng(20261110);
    for (let index = 0; index < 400; index++) {
      frame = stepModel(model, frame, failure.params, rng);
    }
    expect(value(frame, "deadline-overrun")).toBe(54);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBeGreaterThanOrEqual(3);
    expect(model.params.length).toBeLessThanOrEqual(6);
    expect(model.visual).toBe("timeline");
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
