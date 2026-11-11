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
import { module, requestsLimitsModel } from "./module";

const model = requestsLimitsModel;
const presets = module.sims["requests-limits"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("kubernetes requests and limits model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy and never reports NaN, Infinity, or negative values", () => {
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
    expect(value(frame, "oom-kills")).toBe(3);
    expect(value(frame, "pending-pods")).toBe(0);
    expect(value(frame, "cpu-throttle")).toBe(0);
    expect(value(frame, "node-memory-free")).toBe(3_584);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(value(frame, "oom-kills")).toBe(0);
    expect(value(frame, "pod-ready")).toBe(1);
  });

  it("throttles on a CPU limit without killing the pod", () => {
    const frame = runModel(model, params("throttled"), 20261110, 20);
    expect(value(frame, "cpu-throttle")).toBeCloseTo(66.7, 1);
    expect(value(frame, "oom-kills")).toBe(0);
    expect(value(frame, "pod-ready")).toBe(1);
    expect(frame.nodes.find((node) => node.id === "pod")?.health).toBe("warn");
    expect(frame.nodes.find((node) => node.id === "cgroup")?.health).toBe("warn");
  });

  it("copies an omitted request from its limit for scheduling and QoS", () => {
    const frame = runModel(
      model,
      {
        ...params("healthy"),
        cpuRequest: 0,
        cpuLimit: 2_000,
        memoryRequest: 0,
        memoryLimit: 2_048,
      },
      20261110,
      20,
    );
    expect(value(frame, "pending-pods")).toBe(0);
    expect(frame.flags.qos).toBe("Guaranteed");
    expect(value(frame, "node-memory-free")).toBe(2_048);
  });

  it("keeps an OOM kill local to the container limit", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(value(frame, "node-memory-free")).toBeGreaterThan(3_000);
    expect(value(frame, "pod-ready")).toBe(0);
    expect(frame.nodes.find((node) => node.id === "node")?.health).toBe("ok");
    expect(frame.nodes.find((node) => node.id === "pod")?.health).toBe("crit");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const crit = frame.events.filter((event) => event.id === "threshold-oom-kills-crit");
    expect(crit.length).toBe(1);
    expect(crit[0].severity).toBe("crit");
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
    expect(model.params).toHaveLength(5);
    expect(presets).toHaveLength(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.experiments).toHaveLength(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    expect(module.meta.tags).toEqual(["requests", "limits", "QoS", "throttling", "OOM"]);
    expect(module.meta.learningDelta).toBe(
      "Requests drive scheduling and QoS; limits drive throttling and OOM; they are different controls",
    );
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
