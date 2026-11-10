import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, serviceDiscoveryModel } from "./module";

const model = serviceDiscoveryModel;
const presets = module.sims["service-discovery"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 30) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("containers-service-discovery model", () => {
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

  it("stays healthy at steady state without crossing a threshold", () => {
    const frame = runModel(model, params("healthy"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(valueOf("failure", "stale-lookups")).toBeGreaterThanOrEqual(10);
    expect(valueOf("failure", "lookup-errors")).toBeGreaterThanOrEqual(5);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(valueOf("recovery", "stale-lookups")).toBeLessThan(5);
    expect(valueOf("recovery", "lookup-errors")).toBeLessThan(1);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-stale-lookups-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("makes stale answers more likely when TTL is long relative to task lifetime", () => {
    const longTtl = runModel(model, { ...params("healthy"), dnsTtlSeconds: 120, taskLifetimeSeconds: 60 }, 3, 30);
    const shortTtl = runModel(model, { ...params("healthy"), dnsTtlSeconds: 10, taskLifetimeSeconds: 600 }, 3, 30);
    const longStale = longTtl.metrics.find((item) => item.id === "stale-lookups")?.value ?? 0;
    const shortStale = shortTtl.metrics.find((item) => item.id === "stale-lookups")?.value ?? 0;
    expect(longStale).toBeGreaterThan(shortStale);
    expect(longStale).toBeGreaterThanOrEqual(90);
    expect(shortStale).toBeLessThan(2);
  });

  it("keeps dead tasks discoverable when health coverage is missing", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), dnsTtlSeconds: 5, taskLifetimeSeconds: 600, healthCoverage: 0 },
      3,
      30,
    );
    expect(frame.metrics.find((item) => item.id === "unchecked-tasks")?.value).toBe(8);
    expect(frame.metrics.find((item) => item.id === "stale-lookups")?.value).toBeGreaterThanOrEqual(39);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("sets the cached staleness window to the DNS TTL, not the health-detection time", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), dnsTtlSeconds: 60, taskLifetimeSeconds: 300, healthDetectionSeconds: 10 },
      3,
      5,
    );
    expect(frame.metrics.find((item) => item.id === "stale-window")?.value).toBe(60);
    expect(frame.metrics.find((item) => item.id === "dns-ttl")?.value).toBe(60);
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
