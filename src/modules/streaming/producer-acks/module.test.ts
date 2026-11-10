import { describe, expect, it } from "vitest";
import {
  activeNodeIncident,
  activeThreshold,
  applyPresetFrame,
  initModel,
  runModel,
  stepModel,
  TICK,
} from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { producerAcksModel, module } from "./module";

const model = producerAcksModel;
const presets = module.sims["producer-acks"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("streaming-producer-acks model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    const presetFrame = applyPresetFrame(model, preset("healthy"), 20261110);
    expect(activeThreshold(presetFrame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(presetFrame)).toBeNull();
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

  it("crosses warning and critical within 30 simulated seconds", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "durability-risk")).toBe(100);
    expect(frame.events.some((event) => event.id === "threshold-durability-risk-crit")).toBe(true);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "durability-risk")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-durability-risk-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("fires the leader failure event once and clears it on recovery", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "leader-failure").length).toBe(1);
    expect(frame.flags.failureSeen).toBe(1);
    const recovered = runModel(model, params("recovery"), 20261110, 20);
    expect(recovered.flags.failureSeen).toBe(0);
  });

  it("marks the old leader down and promotes a replica", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(metricValue(frame, "durability-risk")).toBe(100);
    expect(metricValue(frame, "produce-errors")).toBe(0);
    expect(metricValue(frame, "isr")).toBe(2);
    expect(frame.nodes.find((node) => node.id === "leader")?.health).toBe("down");
    const promoted = frame.nodes.find((node) => node.meta?.promoted === 1);
    expect(promoted?.role).toBe("primary");
    const event = frame.events.find((item) => item.id === "leader-failure");
    expect(event?.nodeId).toBe("leader");
  });

  it("fails safely with a single replica and a broker loss", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), replicationFactor: 1, brokerFailure: 1 },
      20261110,
      20,
    );
    expect(metricValue(frame, "isr")).toBe(0);
    expect(metricValue(frame, "produce-errors")).toBe(100);
    expect(frame.nodes.find((node) => node.id === "leader")?.health).toBe("down");
    expect(Number.isFinite(metricValue(frame, "ack-latency"))).toBe(true);
  });

  it("acks=all with min.insync.replicas 2 survives one broker loss", () => {
    const frame = runModel(model, { ...params("healthy"), brokerFailure: 1 }, 20261110, 20);
    expect(metricValue(frame, "durability-risk")).toBe(0);
    expect(metricValue(frame, "produce-errors")).toBe(0);
    expect(metricValue(frame, "isr")).toBe(2);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("acks=all with min.insync.replicas 3 rejects writes when the ISR is too small", () => {
    const frame = runModel(model, params("blocked"), 20261110, 20);
    expect(metricValue(frame, "produce-errors")).toBe(100);
    expect(metricValue(frame, "durability-risk")).toBe(0);
    expect(frame.events.some((event) => event.id === "writes-blocked")).toBe(true);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("raises ack latency when acks waits for more replicas", () => {
    const zero = runModel(model, { ...params("healthy"), acks: 0, brokerFailure: 1 }, 20261110, 10);
    const one = runModel(model, { ...params("healthy"), acks: 1, brokerFailure: 1 }, 20261110, 10);
    const all = runModel(model, { ...params("healthy"), acks: 2, brokerFailure: 1 }, 20261110, 10);
    expect(metricValue(zero, "ack-latency")).toBeLessThan(metricValue(one, "ack-latency"));
    expect(metricValue(one, "ack-latency")).toBeLessThan(metricValue(all, "ack-latency"));
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
    expect(presets.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "blocked"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
