import { describe, expect, it } from "vitest";
import type { SimFrame, SimModel } from "@/simulation/engine/types";
import {
  activeThreshold,
  clamp,
  emptyFrame,
  initModel,
  metric,
  pushEvent,
  reconcileThresholds,
  runModel,
  sanitizeFrame,
  setMetric,
  stepModel,
  thresholdStatus,
  TICK,
} from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";

const model: SimModel = {
  id: "test-model",
  visual: "flow",
  params: [
    { id: "load", label: "Load", min: 0, max: 100, step: 1, value: 10, unit: "%", help: "load" },
    { id: "limit", label: "Limit", min: 1, max: 10, step: 1, value: 5, unit: "", help: "limit" },
    { id: "mode", label: "Mode", min: 0, max: 2, step: 1, value: 0, unit: "", help: "mode" },
  ],
  init: () => ({
    ...emptyFrame(),
    metrics: [metric("load", "Load", 10, "%", 50, 80)],
  }),
  step: (frame, params) => {
    setMetric(frame, metric("load", "Load", Number(params.load ?? 0), "%", 50, 80));
    return frame;
  },
  thresholds: [
    { id: "load", metricId: "load", warn: 50, crit: 80, title: "Load high", cause: "load", fix: "reduce" },
  ],
  insights: () => ["insight"],
};

describe("engine frame", () => {
  it("clamps invalid and negative values", () => {
    const frame: SimFrame = {
      ...emptyFrame(1),
      nodes: [{ id: "n", label: "N", kind: "service", health: "ok", utilization: -2 }],
      edges: [{ id: "e", from: "n", to: "n", rate: Number.NaN, health: "ok" }],
      metrics: [{ id: "m", label: "M", value: Number.POSITIVE_INFINITY, unit: "%" }],
      series: { m: [Number.NaN, -1, 3] },
    };
    const clean = sanitizeFrame(frame);
    expect(clean.nodes[0].utilization).toBe(0);
    expect(clean.edges[0].rate).toBe(0);
    expect(clean.metrics[0].value).toBe(0);
    expect(clean.series.m).toEqual([0, 0, 3]);
  });

  it("caps series at the ring buffer size", () => {
    const frame = emptyFrame();
    for (let index = 0; index < 200; index++) {
      setMetric(frame, metric("x", "X", index, ""));
    }
    expect(frame.series.x.length).toBeLessThanOrEqual(120);
    expect(frame.series.x.at(-1)).toBe(199);
  });

  it("deduplicates events inside the window but keeps the first critical event", () => {
    const frame = emptyFrame(10);
    pushEvent(frame, { id: "same", at: 10, severity: "crit", title: "same", detail: "same" });
    pushEvent(frame, { id: "same", at: 12, severity: "crit", title: "same", detail: "same" });
    pushEvent(frame, { id: "same", at: 20, severity: "crit", title: "same", detail: "same" });
    expect(frame.events.filter((event) => event.id === "same")).toHaveLength(2);
  });

  it("transitions thresholds and emits recovery", () => {
    const low = initModel(model, { load: 10 }, 1);
    const high = stepModel(model, low, { load: 90 }, createRng(1));
    expect(thresholdStatus(90, model.thresholds[0])).toBe("crit");
    expect(activeThreshold(high, model.thresholds)?.severity).toBe("crit");
    expect(high.events.some((event) => event.id === "threshold-load-crit")).toBe(true);
    const recovered = stepModel(model, high, { load: 10 }, createRng(1));
    expect(activeThreshold(recovered, model.thresholds)).toBeNull();
    expect(recovered.events.some((event) => event.id === "threshold-load-ok")).toBe(true);
  });

  it("keeps runFor and manual stepping equivalent", () => {
    const seconds = 4;
    const fast = runModel(model, { load: 70 }, 5, seconds);
    let manual = initModel(model, { load: 70 }, 5);
    const rng = createRng(5);
    for (let index = 0; index < seconds / TICK; index++) manual = stepModel(model, manual, { load: 70 }, rng);
    expect(manual.metrics[0].value).toBe(fast.metrics[0].value);
    expect(manual.t).toBeCloseTo(fast.t, 6);
  });

  it("clamps helpers", () => {
    expect(clamp(Number.NaN)).toBe(0);
    expect(clamp(5)).toBe(1);
    expect(clamp(-1)).toBe(0);
    expect(clamp(0.4)).toBe(0.4);
  });

  it("reconciles only matching thresholds", () => {
    const previous = emptyFrame();
    previous.metrics = [metric("load", "Load", 10, "", 50, 80)];
    const next = emptyFrame();
    next.metrics = [metric("load", "Load", 90, "", 50, 80)];
    reconcileThresholds(previous, next, model.thresholds);
    expect(next.events).toHaveLength(1);
  });
});
