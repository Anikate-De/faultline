import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, writeForwardingModel } from "./module";

const model = writeForwardingModel;
const presets = module.sims["write-forwarding"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const node = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.nodes.find((item) => item.id === id);

describe("databases-write-forwarding model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or out-of-range utilization", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const item of frame.nodes) {
      expect(Number.isFinite(item.utilization ?? 0)).toBe(true);
      expect(item.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(item.utilization ?? 0).toBeLessThanOrEqual(1);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((item) => item.health === "ok")).toBe(true);
  });

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "write-p99")).toBeCloseTo(695, 5);
    expect(metricValue(frame, "write-timeouts")).toBeGreaterThanOrEqual(20);
    expect(metricValue(frame, "stale-gap")).toBe(600);
    expect(node(frame, "app")?.health).toBe("crit");
    expect(node(frame, "secondary")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "write-timeouts")).toBe(0);
    expect(metricValue(frame, "write-p99")).toBeCloseTo(415, 5);
    expect(frame.nodes.every((item) => item.health === "ok")).toBe(true);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "forwarded-write-timeout").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "threshold-write-p99-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "forwarded-read-stale").length).toBe(1);
  });

  it("adds a fixed forwarding hop only when forwarding is enabled", () => {
    const direct = runModel(model, { ...params("healthy"), forwarding: 0, rttMs: 200 }, 1, 10);
    const forwarded = runModel(model, { ...params("healthy"), forwarding: 1, rttMs: 200 }, 1, 10);
    expect(metricValue(forwarded, "write-p99") - metricValue(direct, "write-p99")).toBeCloseTo(80, 5);
  });

  it("keeps secondary health out of the write path when forwarding is off", () => {
    const frame = runModel(model, { ...params("healthy"), forwarding: 0, rttMs: 600 }, 1, 10);
    expect(metricValue(frame, "write-p99")).toBeCloseTo(615, 5);
    expect(node(frame, "secondary")?.health).toBe("ok");
    expect(node(frame, "app")?.health).toBe("ok");
  });

  it("labels metrics for the selected path", () => {
    const direct = runModel(model, { ...params("healthy"), forwarding: 0 }, 1, 10);
    const forwarded = runModel(model, { ...params("healthy"), forwarding: 1 }, 1, 10);
    expect(direct.metrics.find((item) => item.id === "write-p99")?.label).toContain("Direct");
    expect(forwarded.metrics.find((item) => item.id === "write-p99")?.label).toContain("Forwarded");
    expect(forwarded.metrics.find((item) => item.id === "write-timeouts")?.label).toContain("modeled");
  });

  it("turns the eventual stale gap into a wait under session consistency", () => {
    const eventual = runModel(model, { ...params("failure"), consistency: 0 }, 1, 10);
    const session = runModel(model, { ...params("failure"), consistency: 1 }, 1, 10);
    expect(metricValue(eventual, "stale-gap")).toBe(600);
    expect(metricValue(eventual, "read-wait")).toBe(0);
    expect(metricValue(session, "stale-gap")).toBe(0);
    expect(metricValue(session, "read-wait")).toBeCloseTo(615, 5);
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
    expect(model.params.length).toBe(3);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
  });
});
