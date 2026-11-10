import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { formatMetric } from "@/lib/format";
import { module, oomModel } from "./module";

const model = oomModel;
const presets = module.sims["oom-kills"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 30) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("containers-oom-kills model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 45);
    const b = runModel(model, params("failure"), 42, 45);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or invalid utilization", () => {
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
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    const running = runModel(model, params("healthy"), 20261110, 1);
    expect(activeThreshold(running, model.thresholds)).toBeNull();
    expect(activeNodeIncident(running)).toBeNull();
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(valueOf("failure", "oom-kills")).toBeGreaterThanOrEqual(1);
    expect(valueOf("failure", "memory-growth")).toBeGreaterThanOrEqual(150);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(valueOf("recovery", "oom-kills")).toBe(0);
    expect(valueOf("recovery", "memory-pressure")).toBeLessThan(80);
  });

  it("keeps one event per OOM kill", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const first = frame.events.filter((event) => event.id === "oom-kill-1");
    expect(first.length).toBe(1);
    expect(first[0].severity).toBe("crit");
    expect(first[0].detail).toContain("137");
    expect(frame.events.filter((event) => event.id === "oom-kill-2").length).toBe(1);
  });

  it("kills at the limit, holds the stop reason, then restarts at baseline", () => {
    const killed = runModel(model, params("failure"), 3, 19);
    expect(killed.metrics.find((item) => item.id === "oom-kills")?.value).toBe(1);
    expect(killed.metrics.find((item) => item.id === "memory-pressure")?.value).toBe(100);
    expect(killed.nodes.find((node) => node.id === "last-stop")?.meta?.exitCode).toBe(137);
    const restarted = runModel(model, params("failure"), 3, 28);
    expect(restarted.metrics.find((item) => item.id === "memory-pressure")?.value).toBeLessThan(100);
    expect(restarted.nodes.find((node) => node.id === "service")?.meta?.oomCount).toBe(1);
  });

  it("computes the time to the limit from the current slope", () => {
    const frame = initModel(model, params("healthy"), 3);
    expect(frame.metrics.find((item) => item.id === "time-to-limit")?.value).toBe(1_872);
    const faster = runModel(
      model,
      { ...params("healthy"), growthMiBPerMinute: 120, trafficMultiplier: 2 },
      3,
      1,
    );
    const runway = faster.metrics.find((item) => item.id === "time-to-limit")?.value ?? 0;
    expect(runway).toBeGreaterThan(150);
    expect(runway).toBeLessThan(160);
  });

  it("keeps a flat workload below the limit with no kills", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), growthMiBPerMinute: 0, baselineUsageMiB: 900, memoryLimitMiB: 1_024 },
      3,
      60,
    );
    expect(frame.metrics.find((item) => item.id === "oom-kills")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "memory-pressure")?.value).toBeCloseTo(87.89, 1);
    expect(frame.metrics.find((item) => item.id === "time-to-limit")?.value).toBe(0);
  });

  it("formats memory metrics in MiB rather than bytes", () => {
    const frame = initModel(model, params("healthy"), 3);
    const used = frame.metrics.find((item) => item.id === "memory-used");
    const limit = frame.metrics.find((item) => item.id === "memory-limit");
    if (!used || !limit) throw new Error("Missing memory metrics");
    expect(used.format).not.toBe("bytes");
    expect(limit.format).not.toBe("bytes");
    expect(formatMetric(used.value, used.unit, used.format)).toBe("400 MiB");
    expect(formatMetric(limit.value, limit.unit, limit.format)).toBe("1024 MiB");
  });

  it("runFor matches stepping the same number of ticks", () => {
    const seconds = 30;
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
    expect(model.params.length).toBeGreaterThanOrEqual(3);
    expect(model.params.length).toBeLessThanOrEqual(6);
    expect(presets.length).toBeGreaterThanOrEqual(4);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
