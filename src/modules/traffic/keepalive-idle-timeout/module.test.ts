import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { keepaliveModel, module } from "./module";

const model = keepaliveModel;
const presets = module.sims.keepalive.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("traffic-keepalive-idle-timeout model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold and no failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
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
    expect(metricValue(frame, "failed-requests")).toBeGreaterThanOrEqual(2);
    expect(metricValue(frame, "new-connections")).toBeGreaterThan(2_000);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 40);
    const critical = frame.events.filter((event) => event.id === "threshold-failed-requests-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "connection-race-502").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["new-connections"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("raising the backend keep-alive above the ALB timeout removes the 502 race", () => {
    const base = params("failure");
    const aligned = { ...base, backendKeepalive: 75 };
    const before = runModel(model, base, 2, 20);
    const after = runModel(model, aligned, 2, 20);
    expect(metricValue(before, "failed-requests")).toBeGreaterThan(1);
    expect(metricValue(after, "failed-requests")).toBe(0);
    expect(metricValue(after, "reuse-requests")).toBeGreaterThan(metricValue(before, "reuse-requests") * 10);
    expect(metricValue(after, "timeout-mismatch")).toBe(0);
  });

  it("raising only the ALB timeout widens the mismatch", () => {
    const base = params("failure");
    const wider = { ...base, albIdleTimeout: 120 };
    const before = runModel(model, base, 2, 20);
    const after = runModel(model, wider, 2, 20);
    expect(metricValue(after, "timeout-mismatch")).toBeGreaterThan(metricValue(before, "timeout-mismatch"));
    expect(metricValue(after, "failed-requests")).toBeGreaterThanOrEqual(metricValue(before, "failed-requests"));
  });

  it("a short ALB timeout closes first and avoids 502s at the cost of churn", () => {
    const frame = runModel(model, params("alb-short"), 6, 20);
    expect(metricValue(frame, "failed-requests")).toBe(0);
    expect(metricValue(frame, "timeout-mismatch")).toBe(0);
    expect(metricValue(frame, "new-connections")).toBeGreaterThan(500);
  });

  it("requests arriving before the backend timer keep the connection alive and avoid 502s", () => {
    const frame = runModel(model, { ...params("failure"), idleGap: 1 }, 5, 20);
    expect(metricValue(frame, "failed-requests")).toBe(0);
    expect(metricValue(frame, "new-connections")).toBeLessThan(1_000);
    expect(metricValue(frame, "reuse-requests")).toBeGreaterThan(1);
  });

  it("emits a backend timeout change event when the previous value is preserved in flags", () => {
    const rng = createRng(5);
    let frame = initModel(model, params("healthy"), 5);
    frame = stepModel(model, frame, params("healthy"), rng);
    frame = stepModel(model, frame, { ...params("healthy"), backendKeepalive: 30 }, rng);
    expect(frame.events.some((event) => event.id === "backend-timeout-change")).toBe(true);
  });

  it("runs the experiment at the mismatched timeout it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-which-timeout");
    expect(experiment?.setup.backendKeepalive).toBe(2);
    expect(experiment?.setup.albIdleTimeout).toBe(60);
    expect(experiment?.setup.idleGap).toBe(5);
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
      const other = stepped.metrics.find((entry) => entry.id === item.id);
      expect(other?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBeGreaterThanOrEqual(3);
    expect(model.params.length).toBeLessThanOrEqual(6);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
