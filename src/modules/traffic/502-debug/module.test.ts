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
import { badGatewayModel, module } from "./module";

const model = badGatewayModel;
const presets = module.sims["502-debug"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
describe("traffic-502-debug model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = runModel(model, params("healthy"), 20261110, 0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(frame.metrics.find((item) => item.id === "error-rate")?.value).toBe(0);
  });

  it("never reports NaN, Infinity, or negative metrics", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const node of frame.nodes) {
      expect(Number.isFinite(node.utilization ?? 0)).toBe(true);
      expect(node.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(node.utilization ?? 0).toBeLessThanOrEqual(1);
      expect(Number.isFinite(node.throughput ?? 0)).toBe(true);
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
    expect(frame.metrics.find((item) => item.id === "error-rate")?.value).toBeGreaterThan(20);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the target health signal green while request-path 502s rise", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const targets = frame.nodes.filter((node) => node.id.startsWith("target-"));
    expect(targets).toHaveLength(3);
    for (const target of targets) expect(target.health).toBe("ok");
    expect(frame.metrics.find((item) => item.id === "healthy-targets")?.value).toBe(3);
    expect(frame.metrics.find((item) => item.id === "target-5xx")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "502-rate")?.value).toBeGreaterThan(100);
  });

  it("keeps the fault event to one occurrence while the condition persists", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    const event = frame.events.filter((item) => item.id === "fault-passes-health-check");
    expect(event).toHaveLength(1);
    expect(event[0].severity).toBe("crit");
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["error-rate"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("changes the source label with the injected fault", () => {
    const reset = runModel(model, params("reset"), 20261110, 10);
    expect(reset.summary).toContain("target connection reset");
    const tls = runModel(model, { ...params("failure"), faultMode: 3 }, 20261110, 10);
    expect(tls.summary).toContain("TLS handshake failure");
    expect(tls.metrics.find((item) => item.id === "p99")?.value).toBeGreaterThan(
      reset.metrics.find((item) => item.id === "p99")?.value ?? 0,
    );
  });

  it("more faulty targets produce more 502s at the same fault share", () => {
    const one = runModel(model, { ...params("failure"), faultyTargets: 1 }, 20261110, 10);
    const two = runModel(model, params("failure"), 20261110, 10);
    expect(two.metrics.find((item) => item.id === "error-rate")?.value ?? 0).toBeGreaterThan(
      one.metrics.find((item) => item.id === "error-rate")?.value ?? 0,
    );
  });

  it("removing the faulty targets clears the 502s at the same traffic", () => {
    const fixed = runModel(model, { ...params("failure"), faultyTargets: 0 }, 20261110, 20);
    expect(fixed.metrics.find((item) => item.id === "error-rate")?.value).toBe(0);
    expect(activeThreshold(fixed, model.thresholds)).toBeNull();
  });

  it("runs the experiment at the malformed-response setup it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "prove-502-source");
    expect(experiment?.setup.faultyTargets).toBe(2);
    expect(experiment?.setup.faultMode).toBe(1);
    const frame = runModel(model, experiment?.setup ?? {}, 20261110, experiment?.runFor ?? 20);
    expect(frame.metrics.find((item) => item.id === "target-5xx")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "error-rate")?.value).toBeGreaterThan(1);
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
    expect(model.params.length).toBe(4);
    expect(presets).toHaveLength(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "reset"]),
    );
    expect(module.experiments).toHaveLength(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    expect(module.meta.tags).toEqual(["502", "bad gateway", "target health", "protocol", "reset", "TLS"]);
    expect(module.meta.learningDelta).toBe(
      "A 502 means the load balancer could not get a valid response from the target; health, protocol, keepalive, and connection reset are the suspects",
    );
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
