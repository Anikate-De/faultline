import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, readAfterWriteModel } from "./module";

const model = readAfterWriteModel;
const presets = module.sims["read-after-write"].presets;
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

describe("databases-read-after-write model", () => {
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
    expect(metricValue(frame, "stale-share")).toBe(0);
    expect(metricValue(frame, "primary-reads")).toBe(500);
  });

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "stale-share")).toBe(25);
    expect(metricValue(frame, "stale-reads")).toBe(625);
    expect(metricValue(frame, "primary-reads")).toBe(0);
    expect(node(frame, "session")?.health).toBe("crit");
    expect(node(frame, "replica")?.health).toBe("ok");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "stale-share")).toBe(0);
    expect(metricValue(frame, "read-wait")).toBe(400);
    expect(frame.nodes.every((item) => item.health === "ok")).toBe(true);
  });

  it("keeps the first event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "read-after-write-stale").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "threshold-stale-share-crit").length).toBe(1);
  });

  it("covers staleness when the sticky window reaches the lag", () => {
    const short = runModel(model, { ...params("healthy"), policy: 1, replicaLagMs: 1_200, stickyWindowMs: 200 }, 1, 10);
    const covered = runModel(model, { ...params("healthy"), policy: 1, replicaLagMs: 1_200, stickyWindowMs: 1_200 }, 1, 10);
    expect(metricValue(short, "stale-share")).toBeCloseTo(20.833, 2);
    expect(metricValue(covered, "stale-share")).toBe(0);
    expect(metricValue(covered, "primary-reads")).toBe(500);
  });

  it("fires the stale-read event at the warning threshold with matching severity", () => {
    const warn = runModel(model, { ...params("healthy"), policy: 1, replicaLagMs: 1_000, stickyWindowMs: 975 }, 1, 10);
    const crit = runModel(model, params("failure"), 1, 10);
    expect(metricValue(warn, "stale-share")).toBeCloseTo(0.625, 6);
    expect(warn.events.find((event) => event.id === "read-after-write-stale")?.severity).toBe("warn");
    expect(crit.events.find((event) => event.id === "read-after-write-stale")?.severity).toBe("crit");
  });

  it("fires the version wait at the critical threshold with matching severity", () => {
    const frame = runModel(model, { ...params("healthy"), policy: 2, replicaLagMs: 3_000 }, 1, 10);
    expect(metricValue(frame, "read-wait")).toBe(3_000);
    expect(frame.events.find((event) => event.id === "version-token-wait")?.severity).toBe("crit");
  });

  it("trades staleness for wait with a version token", () => {
    const token = runModel(model, { ...params("healthy"), policy: 2, replicaLagMs: 1_200 }, 1, 10);
    expect(metricValue(token, "stale-share")).toBe(0);
    expect(metricValue(token, "read-wait")).toBe(1_200);
    expect(metricValue(token, "primary-reads")).toBe(0);
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
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
  });
});
