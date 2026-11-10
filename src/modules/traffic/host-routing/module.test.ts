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
import { hostRoutingModel, module } from "./module";

const model = hostRoutingModel;
const presets = module.sims["host-routing"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 20) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("traffic-host-routing model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
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
    expect(frame.metrics.find((item) => item.id === "tls-handshake-failures")?.value).toBe(100);
    expect(frame.metrics.some((item) => item.id === "p99")).toBe(false);
    expect(frame.nodes.find((node) => node.id === "targets")?.health).toBe("ok");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("fires the TLS mismatch event once and preserves flags", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "tls-host-mismatch")).toHaveLength(1);
    expect(frame.flags.tlsMismatch).toBe(1);
    expect(frame.flags.seed).toBe(20261110);
    expect(typeof frame.flags.paramsKey).toBe("string");
  });

  it("does not cover a multi-level host with a one-label wildcard", () => {
    expect(valueOf("failure", "certificate-coverage")).toBe(0);
    expect(valueOf("recovery", "certificate-coverage")).toBe(100);
    const wildcardAdmin = runModel(
      model,
      { ...params("healthy"), tenantHost: 2, certificateScope: 1, ruleCoverage: 2 },
      20261110,
      20,
    );
    expect(wildcardAdmin.metrics.find((item) => item.id === "certificate-coverage")?.value).toBe(100);
  });

  it("sends a host without a rule to the default route after TLS succeeds", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), tenantHost: 2, certificateScope: 2, ruleCoverage: 1 },
      20261110,
      20,
    );
    expect(frame.metrics.find((item) => item.id === "tls-handshake-failures")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "misrouted")?.value).toBe(100);
    expect(frame.flags.hostMiss).toBe(1);
  });

  it("bypasses the ALB with an NLB TCP passthrough path", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), tenantHost: 1, certificateScope: 2, ruleCoverage: 2, tlsTermination: 1 },
      20261110,
      20,
    );
    expect(frame.metrics.find((item) => item.id === "tls-handshake-failures")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "misrouted")?.value).toBe(100);
    expect(frame.nodes.some((node) => node.id === "nlb")).toBe(true);
    expect(frame.nodes.some((node) => node.id === "alb")).toBe(false);
    expect(frame.metrics.some((item) => item.id === "p99")).toBe(false);
  });

  it("surfaces the rule quota before it blocks a deployment", () => {
    expect(valueOf("peak", "rules-used")).toBe(95);
    expect(valueOf("peak", "rule-headroom")).toBe(5);
    const over = runModel(model, { ...params("healthy"), ruleCount: 120 }, 20261110, 20);
    expect(over.metrics.find((item) => item.id === "rule-headroom")?.value).toBe(0);
    expect(over.flags.ruleLimit).toBe(1);
  });

  it("runs the experiment on the wildcard gap it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-wildcard-gap");
    expect(experiment?.setup.tenantHost).toBe(3);
    expect(experiment?.setup.certificateScope).toBe(1);
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
    expect(model.params.length).toBe(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.interview.length).toBe(module.meta.interviewQuestions);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
