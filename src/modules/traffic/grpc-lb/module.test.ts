import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { grpcModel, module } from "./module";

const model = grpcModel;
const presets = module.sims.grpc.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("traffic-grpc-lb model", () => {
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
    expect(metricValue(frame, "max-backend-load")).toBeGreaterThan(95);
    expect(metricValue(frame, "idle-backends")).toBe(32);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 40);
    const critical = frame.events.filter((event) => event.id === "threshold-max-backend-load-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "grpc-connection-pinning").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["max-backend-load"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("an L7 proxy uses every backend and removes connection pinning", () => {
    const l4 = runModel(model, params("failure"), 3, 20);
    const l7 = runModel(model, { ...params("failure"), balancingMode: 1 }, 3, 20);
    expect(metricValue(l4, "idle-backends")).toBe(32);
    expect(metricValue(l7, "idle-backends")).toBe(0);
    expect(metricValue(l7, "max-backend-load")).toBeLessThan(metricValue(l4, "max-backend-load"));
    expect(metricValue(l7, "p99")).toBeLessThan(metricValue(l4, "p99"));
  });

  it("client-side balancing spreads load but multiplies connections", () => {
    const frame = runModel(model, params("client-side"), 3, 20);
    expect(metricValue(frame, "idle-backends")).toBe(0);
    expect(metricValue(frame, "max-backend-load")).toBeLessThan(85);
    expect(metricValue(frame, "connections")).toBe(320);
  });

  it("a low stream cap queues streams without leaving backends idle", () => {
    const frame = runModel(model, params("peak"), 3, 20);
    expect(metricValue(frame, "idle-backends")).toBe(0);
    expect(metricValue(frame, "streams-per-connection")).toBeGreaterThan(50);
    expect(metricValue(frame, "queued-streams")).toBeGreaterThan(0);
    expect(metricValue(frame, "p99")).toBeGreaterThan(100);
  });

  it("runs the experiment in connection-level mode as it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-grpc-pinning");
    expect(experiment?.setup.balancingMode).toBe(0);
    expect(experiment?.setup.clientCount).toBe(8);
    expect(experiment?.setup.backendCount).toBe(40);
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
