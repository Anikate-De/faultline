import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { meshTracingModel, module } from "./module";

const model = meshTracingModel;
const presets = module.sims["mesh-tracing"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("mesh-tracing model", () => {
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
      expect(Number.isFinite(node.span?.duration ?? 0)).toBe(true);
      expect(node.span?.duration ?? 0).toBeGreaterThanOrEqual(0);
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
    expect(value(frame, "broken-traces")).toBe(75);
    expect(value(frame, "missing-proxy")).toBe(60);
    expect(value(frame, "unsampled")).toBe(99);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "broken-traces")).toBe(0);
    expect(value(frame, "missing-proxy")).toBe(0);
  });

  it("warns without failing in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "broken-traces")).toBeLessThan(20);
    expect(value(frame, "missing-proxy")).toBeLessThan(20);
    expect(value(frame, "unsampled")).toBe(95);
  });

  it("keeps sampling separate from context continuity", () => {
    const frame = runModel(model, { ...params("healthy"), samplePercent: 1 }, 20261110, 20);
    expect(value(frame, "broken-traces")).toBe(0);
    expect(value(frame, "missing-proxy")).toBe(0);
    expect(value(frame, "unsampled")).toBe(99);
    expect(activeThreshold(frame, model.thresholds)?.threshold.id).toBe("unsampled");
  });

  it("removes the payment spans when context is not forwarded", () => {
    const frame = runModel(model, { ...params("healthy"), forwardPercent: 0 }, 20261110, 20);
    const payment = frame.nodes.find((node) => node.id === "payment");
    const proxy = frame.nodes.find((node) => node.id === "payment-proxy");
    expect(payment?.span?.missing).toBe(true);
    expect(proxy?.span?.missing).toBe(true);
    expect(payment?.health).toBe("down");
  });

  it("keeps application spans when only proxy tracing is disabled", () => {
    const frame = runModel(model, { ...params("healthy"), proxyTracingPercent: 0 }, 20261110, 20);
    expect(frame.nodes.find((node) => node.id === "checkout")?.span?.missing).toBeFalsy();
    expect(frame.nodes.find((node) => node.id === "checkout-proxy")?.span?.missing).toBe(true);
    expect(value(frame, "broken-traces")).toBe(0);
    expect(value(frame, "missing-proxy")).toBe(100);
  });

  it("keeps incident events to one occurrence", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "trace-context-broken")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "proxy-spans-missing")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "trace-sampling-hides")).toHaveLength(1);
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
    expect(presets).toHaveLength(4);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.experiments).toHaveLength(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    expect(module.meta.tags).toEqual(["tracing", "sidecar span", "context", "sampling", "upstream"]);
    expect(module.meta.learningDelta).toBe(
      "Mesh tracing requires context propagation and proxy span generation; sampling and header handling decide continuity",
    );
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
