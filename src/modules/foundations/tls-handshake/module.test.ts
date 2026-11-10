import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, tlsModel } from "./module";

const model = tlsModel;
const presets = module.sims.tls.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((metric) => metric.id === id)?.value ?? 0;

describe("foundations-tls-handshake model", () => {
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

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "new-connections")).toBeGreaterThan(15_000);
    expect(metricValue(frame, "handshake-cpu")).toBe(100);
    expect(metricValue(frame, "handshake-demand")).toBeGreaterThan(100);
    expect(metricValue(frame, "handshake-p99")).toBeGreaterThan(250);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-new-connections-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("reduces handshake CPU by increasing requests per connection", () => {
    const base = params("failure");
    const reused = { ...base, keepAliveRequests: 40 };
    const before = runModel(model, base, 11, 20);
    const after = runModel(model, reused, 11, 20);
    expect(metricValue(after, "new-connections")).toBeLessThan(metricValue(before, "new-connections"));
    expect(metricValue(after, "handshake-cpu")).toBeLessThan(metricValue(before, "handshake-cpu"));
  });

  it("reduces CPU with resumption without changing the connection count", () => {
    const base = params("peak");
    const resumed = { ...base, resumptionHitRate: 80 };
    const before = runModel(model, base, 11, 20);
    const after = runModel(model, resumed, 11, 20);
    expect(metricValue(after, "new-connections")).toBeCloseTo(metricValue(before, "new-connections"), 5);
    expect(metricValue(after, "handshake-cpu")).toBeLessThan(metricValue(before, "handshake-cpu"));
  });

  it("models a latency-only incident when the edge is far away", () => {
    const frame = runModel(model, params("far-edge"), 4, 20);
    expect(metricValue(frame, "handshake-cpu")).toBeLessThan(70);
    expect(metricValue(frame, "handshake-p99")).toBeGreaterThan(250);
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
  });
});
