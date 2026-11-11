import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { incidentDebugModel, module } from "./module";

const model = incidentDebugModel;
const presets = module.sims["incident-debug"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (frame: ReturnType<typeof runModel>, metricId: string) =>
  frame.metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("kubernetes-incident-debug model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative utilization", () => {
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
    for (const series of Object.values(frame.series)) {
      for (const point of series) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("is healthy in the healthy preset", () => {
    const frame = runModel(model, params("healthy"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
  });

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.nodes.some((node) => node.health === "crit")).toBe(true);
    expect(valueOf(frame, "notready-nodes")).toBe(1);
    expect(valueOf(frame, "pending-pods")).toBe(8);
    expect(valueOf(frame, "wrong-layer")).toBe(1);
    expect(valueOf(frame, "mttr")).toBeGreaterThan(30);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
    expect(valueOf(frame, "mttr")).toBeCloseTo(8, 0);
  });

  it("warns when pressure creates a small capacity gap", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(valueOf(frame, "notready-nodes")).toBe(0);
    expect(valueOf(frame, "pending-pods")).toBe(2);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("treats readiness and memory pressure as independent states", () => {
    const pressureOnly = runModel(
      model,
      { ...params("failure"), kubeletNotReady: 0, pendingReplicas: 0, crashLoopReplicas: 0 },
      20261110,
      20,
    );
    expect(valueOf(pressureOnly, "notready-nodes")).toBe(0);
    expect(valueOf(pressureOnly, "unavailable-pods")).toBeGreaterThan(0);
    expect(pressureOnly.nodes.find((node) => node.id === "node-2")?.health).toBe("warn");

    const readinessOnly = runModel(
      model,
      { ...params("healthy"), kubeletNotReady: 1, nodeMemoryUsedPct: 72 },
      20261110,
      20,
    );
    expect(valueOf(readinessOnly, "notready-nodes")).toBe(1);
    expect(valueOf(readinessOnly, "unavailable-pods")).toBe(0);
    expect(readinessOnly.nodes.find((node) => node.id === "node-2")?.health).toBe("crit");
  });

  it("a healthy node still has useful logs for a crash loop", () => {
    const frame = runModel(model, params("crashloop"), 20261110, 20);
    expect(valueOf(frame, "notready-nodes")).toBe(0);
    expect(valueOf(frame, "crashloop-pods")).toBe(4);
    expect(valueOf(frame, "wrong-layer")).toBe(0);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("logs-first triage increases modeled time when the cause is below the container", () => {
    const logsFirst = runModel(
      model,
      { ...params("failure"), triagePath: 0 },
      20261110,
      20,
    );
    const statusFirst = runModel(
      model,
      { ...params("failure"), triagePath: 1 },
      20261110,
      20,
    );
    expect(valueOf(logsFirst, "mttr")).toBeGreaterThan(valueOf(statusFirst, "mttr"));
    expect(valueOf(logsFirst, "wrong-layer")).toBe(1);
    expect(valueOf(statusFirst, "wrong-layer")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-mttr-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "triage-node-notready").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "triage-pending").length).toBe(1);
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


  it("preserves engine flags across a step", () => {
    let frame = initModel(model, params("healthy"), 5);
    frame.flags.preset = "test";
    frame.flags.custom = 7;
    frame = stepModel(model, frame, params("healthy"), createRng(5));
    expect(frame.flags.preset).toBe("test");
    expect(frame.flags.custom).toBe(7);
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBeGreaterThanOrEqual(3);
    expect(model.params.length).toBeLessThanOrEqual(6);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
