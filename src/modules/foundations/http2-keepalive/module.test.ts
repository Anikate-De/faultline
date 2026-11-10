import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { http2Model, module } from "./module";

const model = http2Model;
const presets = module.sims.http2.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((metric) => metric.id === id)?.value ?? 0;

describe("foundations-http2-keepalive model", () => {
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

  it("crosses the connection-churn critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "new-connections")).toBeGreaterThan(2_000);
    expect(metricValue(frame, "reuse-ratio")).toBeLessThan(2);
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

  it("restores reuse when the shortest timeout is aligned with the other peers", () => {
    const base = params("failure");
    const aligned = { ...base, backendIdleTimeout: 65 };
    const before = runModel(model, base, 2, 20);
    const after = runModel(model, aligned, 2, 20);
    expect(metricValue(after, "new-connections")).toBeLessThan(metricValue(before, "new-connections"));
    expect(metricValue(after, "reuse-ratio")).toBeGreaterThan(metricValue(before, "reuse-ratio") * 10);
    expect(metricValue(after, "timeout-spread")).toBeLessThan(20);
  });

  it("uses the shortest timeout regardless of which peer owns it", () => {
    const base = params("healthy");
    const clientShort = runModel(model, { ...base, clientIdleTimeout: 5 }, 3, 10);
    const backendShort = runModel(model, { ...base, backendIdleTimeout: 5 }, 3, 10);
    expect(metricValue(clientShort, "new-connections")).toBeCloseTo(
      metricValue(backendShort, "new-connections"),
      5,
    );
    expect(metricValue(clientShort, "effective-timeout")).toBe(5);
  });

  it("retires connections at the max-request cap even when timeouts are aligned", () => {
    const capped = { ...params("healthy"), maxRequestsPerConnection: 10 };
    const frame = runModel(model, capped, 3, 10);
    expect(metricValue(frame, "reuse-ratio")).toBe(10);
    expect(metricValue(frame, "new-connections")).toBeCloseTo(300, 0);
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
