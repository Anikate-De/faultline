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
import { l4VsL7Model, module } from "./module";

const model = l4VsL7Model;
const presets = module.sims["l4-vs-l7"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 20) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("traffic-l4-vs-l7 model", () => {
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
    expect(frame.metrics.find((item) => item.id === "misrouted")?.value).toBe(100);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("fires the layer mismatch event once and preserves flags", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "l4-cannot-route")).toHaveLength(1);
    expect(frame.flags.routingBroken).toBe(1);
    expect(frame.flags.seed).toBe(20261110);
    expect(typeof frame.flags.paramsKey).toBe("string");
  });

  it("routes path traffic only when an ALB is present", () => {
    expect(valueOf("failure", "misrouted")).toBe(100);
    expect(valueOf("recovery", "misrouted")).toBe(0);
    const albOnly = runModel(
      model,
      { ...params("recovery"), topology: 1 },
      20261110,
      20,
    );
    expect(albOnly.metrics.find((item) => item.id === "misrouted")?.value).toBe(0);
  });

  it("sends wrong-service requests to a target instead of dropping them", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.metrics.find((item) => item.id === "routed")?.value).toBe(80_000);
    expect(frame.metrics.find((item) => item.id === "wrong-service-rps")?.value).toBe(80_000);
    expect(frame.nodes.find((node) => node.id === "targets")?.throughput).toBe(80_000);
    expect(frame.metrics.find((item) => item.id === "target-load")?.value).toBeCloseTo(88.9, 1);
  });

  it("drops static IP coverage on an ALB-only path", () => {
    expect(valueOf("healthy", "static-ip")).toBe(100);
    const albOnly = runModel(model, { ...params("healthy"), topology: 1 }, 20261110, 20);
    expect(albOnly.metrics.find((item) => item.id === "static-ip")?.value).toBe(0);
  });

  it("shows connection rejects as failed requests, not a capped zero", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), connectionRate: 20_000, requestsPerConnection: 1 },
      20261110,
      20,
    );
    expect(frame.metrics.find((item) => item.id === "rejected-connections")?.value).toBeGreaterThan(0);
    expect(frame.metrics.find((item) => item.id === "error-rate")?.value).toBeGreaterThan(50);
  });

  it("runs the experiment on the L4-only path it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-l4-path");
    expect(experiment?.setup.topology).toBe(0);
    expect(experiment?.setup.pathRouting).toBe(1);
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
