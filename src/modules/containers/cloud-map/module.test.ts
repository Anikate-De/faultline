import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { cloudMapModel, module } from "./module";

const model = cloudMapModel;
const presets = module.sims["cloud-map"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 10) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("containers-cloud-map model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
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
    const frame = runModel(model, params("failure"), 20261110, 10);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(valueOf("failure", "query-failures")).toBeGreaterThanOrEqual(5);
    expect(valueOf("failure", "stale-instances")).toBeGreaterThanOrEqual(3);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(valueOf("recovery", "query-failures")).toBe(0);
    expect(valueOf("recovery", "stale-instances")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-query-failures-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("returns every registered instance when no health check is configured", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), instanceCount: 8, unhealthyShare: 25, healthCheckMode: 0, dnsTtlSeconds: 60 },
      3,
      10,
    );
    expect(frame.metrics.find((item) => item.id === "registered-instances")?.value).toBe(8);
    expect(frame.metrics.find((item) => item.id === "resolvable-instances")?.value).toBe(8);
    expect(frame.metrics.find((item) => item.id === "stale-instances")?.value).toBe(2);
    expect(frame.metrics.find((item) => item.id === "query-failures")?.value).toBeCloseTo(25, 5);
  });

  it("removes unhealthy instances from new answers when a check is enabled", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), instanceCount: 8, unhealthyShare: 25, healthCheckMode: 2, dnsTtlSeconds: 15 },
      3,
      10,
    );
    expect(frame.metrics.find((item) => item.id === "resolvable-instances")?.value).toBe(6);
    expect(frame.metrics.find((item) => item.id === "healthy-instances")?.value).toBe(6);
    expect(frame.metrics.find((item) => item.id === "stale-instances")?.value).toBe(0.3);
    expect(frame.metrics.find((item) => item.id === "query-failures")?.value).toBeCloseTo(3.75, 5);
  });

  it("never reports lookup failures when no failing instance stays answerable", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), instanceCount: 8, unhealthyShare: 12.5, healthCheckMode: 2, dnsTtlSeconds: 5 },
      3,
      10,
    );
    expect(frame.metrics.find((item) => item.id === "stale-instances")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "query-failures")?.value).toBe(0);
  });

  it("derives query failures from answerable stale instances, not a hidden multiplier", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), instanceCount: 10, unhealthyShare: 40, healthCheckMode: 0, dnsTtlSeconds: 120 },
      3,
      10,
    );
    const stale = frame.metrics.find((item) => item.id === "stale-instances")?.value ?? 0;
    const failures = frame.metrics.find((item) => item.id === "query-failures")?.value ?? 0;
    expect(stale).toBe(4);
    expect(failures).toBeCloseTo((stale / 10) * 100, 5);
  });

  it("uses a custom health status rather than a health check unavailable in private DNS", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), instanceCount: 8, unhealthyShare: 15, healthCheckMode: 1, dnsTtlSeconds: 30 },
      3,
      10,
    );
    expect(frame.nodes.find((node) => node.id === "service")?.sublabel).toContain("Custom health status");
    expect(frame.metrics.find((item) => item.id === "health-lag")?.value).toBe(60);
  });

  it("reports no removal delay when there are no unhealthy instances", () => {
    const frame = runModel(model, { ...params("healthy"), unhealthyShare: 0, healthCheckMode: 0 }, 3, 10);
    expect(frame.metrics.find((item) => item.id === "health-lag")?.value).toBe(0);
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
