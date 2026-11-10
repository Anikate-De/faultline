import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, failoverDnsModel } from "./module";

const model = failoverDnsModel;
const presets = module.sims["failover-dns"].presets;
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

describe("databases-failover-dns model", () => {
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
    expect(metricValue(frame, "convergence")).toBe(0);
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "convergence")).toBe(302);
    expect(metricValue(frame, "stale-share")).toBe(100);
    expect(metricValue(frame, "reconnect")).toBe(3_000);
    expect(node(frame, "app")?.health).toBe("crit");
    expect(node(frame, "dns")?.health).toBe("crit");
    expect(node(frame, "pool")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "convergence")).toBe(0);
    expect(metricValue(frame, "stale-share")).toBe(0);
    expect(frame.nodes.every((item) => item.health === "ok")).toBe(true);
    expect(frame.events.filter((event) => event.id === "traffic-reached-new-writer").length).toBe(1);
  });

  it("keeps the first event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "writer-failover-started").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "pool-outlives-dns").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "threshold-convergence-crit").length).toBe(1);
  });

  it("uses the slower of DNS and pool rather than adding them", () => {
    const frame = runModel(model, params("stale-pool"), 1, 20);
    expect(metricValue(frame, "convergence")).toBe(302);
    expect(metricValue(frame, "dns-ttl")).toBe(5);
    expect(metricValue(frame, "pool-recycle")).toBe(300);
  });

  it("moves traffic once the pool validates on checkout", () => {
    const frame = runModel(model, params("recovery"), 1, 8);
    expect(metricValue(frame, "convergence")).toBe(0);
    expect(metricValue(frame, "stale-share")).toBe(0);
    expect(node(frame, "app")?.health).toBe("ok");
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
