import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { meshIngressModel, module } from "./module";

const model = meshIngressModel;
const presets = module.sims["mesh-ingress"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("mesh-ingress model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy and never reports NaN, Infinity, or negative metrics", () => {
    const start = runModel(model, params("healthy"), 20261110, 0);
    expect(activeThreshold(start, model.thresholds)).toBeNull();
    expect(activeNodeIncident(start)).toBeNull();
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
      for (const item of values) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses critical within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "gap")).toBe(100);
    expect(value(frame, "bypass")).toBe(60);
    expect(frame.nodes.find((node) => node.id === "pod-ip")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "gap")).toBe(0);
    expect(value(frame, "bypass")).toBe(0);
  });

  it("warns without failing in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "gap")).toBe(5);
    expect(value(frame, "gateway-util")).toBeLessThan(90);
    expect(value(frame, "gateway-util")).toBeGreaterThan(75);
  });

  it("keeps full gateway traffic out of the bypass path when closed", () => {
    const frame = runModel(model, { ...params("healthy"), bypassShare: 0 }, 20261110, 20);
    const gateway = frame.nodes.find((node) => node.id === "gateway");
    const direct = frame.nodes.find((node) => node.id === "pod-ip");
    expect(gateway?.throughput).toBe(10_000);
    expect(direct?.throughput).toBe(0);
    expect(direct?.health).toBe("ok");
  });

  it("counts optional TLS as partial coverage", () => {
    const strict = runModel(model, { ...params("healthy"), tlsMode: 2 }, 20261110, 20);
    const optional = runModel(model, { ...params("healthy"), tlsMode: 1 }, 20261110, 20);
    expect(value(strict, "gap")).toBe(0);
    expect(value(optional, "gap")).toBe(50);
    expect(activeThreshold(optional, model.thresholds)?.severity).toBe("crit");
  });

  it("fails a plaintext gateway even with no bypass", () => {
    const frame = runModel(model, params("plaintext"), 20261110, 30);
    expect(value(frame, "bypass")).toBe(0);
    expect(value(frame, "gap")).toBe(100);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("keeps bypass and capacity events to one occurrence", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "ingress-bypass")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "ingress-plaintext")).toHaveLength(1);
  });

  it("runFor matches stepping the same number of ticks", () => {
    const seconds = 20;
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
    expect(model.params).toHaveLength(4);
    expect(presets).toHaveLength(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.experiments).toHaveLength(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    expect(module.meta.tags).toEqual(["ingress", "gateway", "TLS", "policy", "bypass"]);
    expect(module.meta.learningDelta).toBe(
      "An ingress gateway provides a controlled entry point with TLS, routing, and policy; bypass paths defeat mTLS and observability",
    );
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
