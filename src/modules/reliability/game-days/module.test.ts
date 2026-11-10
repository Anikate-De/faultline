import { describe, expect, it } from "vitest";
import {
  activeNodeIncident,
  activeThreshold,
  initModel,
  runModel,
  stepModel,
  TICK,
} from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { gameDayModel, module } from "./module";

const model = gameDayModel;
const presets = module.sims["game-days"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("reliability-game-days model", () => {
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
    expect(metricValue(frame, "unhandled-injects")).toBeGreaterThanOrEqual(4);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("replaces the seed game-day event with failure values on the first tick", () => {
    const frame = runModel(model, params("failure"), 20261110, 0.1);
    const event = frame.events[0];
    expect(event?.id).toBe("game-day-brief");
    expect(event?.detail).toContain("7 injects are planned");
    expect(event?.detail).toContain("Role coverage is 20%");
    expect(event?.detail).toContain("update cadence is 45 minutes");
  });

  it("keeps scenario health independent of complexity", () => {
    const frame = runModel(model, params("failure"), 20261110, 0.1);
    expect(frame.nodes.find((node) => node.id === "scenario")?.health).toBe("ok");
  });

  it("does not backfill queued injects when complexity rises mid-run", () => {
    const low = params("healthy");
    const high = params("failure");
    const seed = 20261110;
    const rng = createRng(seed);
    let frame = initModel(model, low, seed);
    for (let index = 0; index < 400; index++) frame = stepModel(model, frame, low, rng);
    const beforeEvents = frame.events.filter((event) => event.id.startsWith("game-day-inject-")).length;
    const beforeUnhandled = metricValue(frame, "unhandled-injects");
    for (let index = 0; index < 20; index++) frame = stepModel(model, frame, high, rng);
    const afterEvents = frame.events.filter((event) => event.id.startsWith("game-day-inject-")).length;
    expect(afterEvents).toBe(beforeEvents);
    expect(metricValue(frame, "unhandled-injects")).toBeLessThanOrEqual(beforeUnhandled + 1);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-coordination-gap-crit");
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("separates a good response from a good debrief", () => {
    const noDebrief = runModel(model, params("no-debrief"), 20261110, 60);
    const recovery = runModel(model, params("recovery"), 20261110, 60);
    expect(metricValue(noDebrief, "coordination-gap")).toBeLessThan(metricValue(recovery, "coordination-gap") + 15);
    expect(metricValue(noDebrief, "debrief-gaps")).toBeGreaterThan(metricValue(recovery, "debrief-gaps"));
    expect(metricValue(noDebrief, "debrief-gaps")).toBeGreaterThanOrEqual(3);
  });

  it("shows more unhandled injects when roles are missing", () => {
    const failure = runModel(model, params("failure"), 20261110, 40);
    const healthy = runModel(model, params("healthy"), 20261110, 40);
    expect(metricValue(failure, "unhandled-injects")).toBeGreaterThan(metricValue(healthy, "unhandled-injects"));
    expect(metricValue(failure, "ack-latency")).toBeGreaterThan(metricValue(healthy, "ack-latency"));
    expect(metricValue(failure, "coordination-gap")).toBeGreaterThan(metricValue(healthy, "coordination-gap"));
  });

  it("fires each scenario inject once", () => {
    const frame = runModel(model, params("healthy"), 20261110, 60);
    const ids = frame.events.map((event) => event.id).filter((id) => id.startsWith("game-day-inject-"));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
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
    expect(module.experiments[0]?.simId).toBe("game-days");
    expect(module.meta.tags).toEqual(["game day", "scenario", "roles", "communication", "debrief"]);
  });
});
