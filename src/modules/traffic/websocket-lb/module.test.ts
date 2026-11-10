import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, websocketModel } from "./module";

const model = websocketModel;
const presets = module.sims.websocket.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("traffic-websocket-lb model", () => {
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
    expect(metricValue(frame, "idle-disconnects")).toBeGreaterThan(5_000);
    expect(metricValue(frame, "failed-reconnects")).toBeGreaterThan(500);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 40);
    const critical = frame.events.filter((event) => event.id === "threshold-disconnects-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "idle-timeout-close").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["idle-disconnects"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("a heartbeat below the idle timeout removes idle disconnects", () => {
    const noHeartbeat = { ...params("failure"), heartbeatInterval: 0 };
    const withHeartbeat = { ...params("failure"), heartbeatInterval: 20 };
    const before = runModel(model, noHeartbeat, 3, 20);
    const after = runModel(model, withHeartbeat, 3, 20);
    expect(metricValue(before, "idle-disconnects")).toBeGreaterThan(0);
    expect(metricValue(after, "idle-disconnects")).toBe(0);
    expect(metricValue(after, "reconnects")).toBeLessThan(metricValue(before, "reconnects"));
  });

  it("counts idle closes inside a message gap instead of one per gap", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-idle-websocket");
    const frame = runModel(model, experiment?.setup ?? params("failure"), 7, 20);
    expect(metricValue(frame, "idle-disconnects")).toBeCloseTo(26_666.67, 1);
    expect(metricValue(frame, "reconnects")).toBeCloseTo(458, 0);
  });

  it("emits a heartbeat change event when the previous value is preserved in flags", () => {
    const rng = createRng(6);
    let frame = initModel(model, params("healthy"), 6);
    frame = stepModel(model, frame, params("healthy"), rng);
    frame = stepModel(model, frame, { ...params("healthy"), heartbeatInterval: 5 }, rng);
    expect(frame.events.some((event) => event.id === "heartbeat-change")).toBe(true);
  });

  it("a longer drain window removes failed reconnects but not deploy disconnects", () => {
    const shortDrain = { ...params("failure"), heartbeatInterval: 20, drainWindow: 0 };
    const longDrain = { ...shortDrain, drainWindow: 60 };
    const before = runModel(model, shortDrain, 4, 20);
    const after = runModel(model, longDrain, 4, 20);
    expect(metricValue(before, "failed-reconnects")).toBeGreaterThan(0);
    expect(metricValue(after, "failed-reconnects")).toBe(0);
    expect(metricValue(after, "disconnects")).toBeGreaterThan(0);
  });

  it("uses the shorter of the message and heartbeat intervals", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), messageInterval: 90, heartbeatInterval: 15, albIdleTimeout: 30 },
      8,
      20,
    );
    expect(metricValue(frame, "effective-gap")).toBe(15);
    expect(metricValue(frame, "idle-disconnects")).toBe(0);
  });

  it("runs the experiment with no heartbeat as it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-idle-websocket");
    expect(experiment?.setup.heartbeatInterval).toBe(0);
    expect(experiment?.setup.albIdleTimeout).toBe(60);
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
