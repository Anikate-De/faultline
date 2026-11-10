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
import { dnsFailureModel, module } from "./module";

const model = dnsFailureModel;
const presets = module.sims["dns-failure"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("reliability-dns-failure model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or out-of-range utilization", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const node of frame.nodes) {
      expect(Number.isFinite(node.utilization ?? 0)).toBe(true);
      expect(node.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(node.utilization ?? 0).toBeLessThanOrEqual(1);
      expect(Number.isFinite(node.throughput ?? 0)).toBe(true);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("loads healthy with no active threshold or failing node at t=0", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "resolution-errors")).toBe(100);
    expect(metricValue(frame, "resolver-latency")).toBeGreaterThan(800);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "resolution-errors")).toBe(0);
    expect(metricValue(frame, "nxdomain-rate")).toBe(0);
  });

  it("separates a reachable zone with a bad record from an unreachable zone", () => {
    const record = runModel(model, params("record-deleted"), 20261110, 30);
    const zone = runModel(model, params("failure"), 20261110, 30);
    expect(metricValue(record, "nxdomain-rate")).toBe(100);
    expect(metricValue(zone, "nxdomain-rate")).toBe(0);
    expect(frameNode(zone, "zone")?.health).toBe("down");
    expect(frameNode(record, "zone")?.health).toBe("crit");
  });

  it("keeps downstream services healthy during a DNS outage", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(frame.nodes.find((node) => node.id === "api")?.health).toBe("ok");
    expect(frame.nodes.find((node) => node.id === "payments")?.health).toBe("ok");
    expect(frame.nodes.find((node) => node.id === "cdn")?.health).toBe("ok");
    expect(frame.nodes.find((node) => node.id === "clients")?.health).toBe("crit");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter(
      (event) => event.id === "threshold-resolution-errors-crit",
    );
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("shows cached answers delaying the failure until the TTL expires", () => {
    const early = runModel(
      model,
      { ...params("failure"), cachedResolverPct: 100, recordTtlS: 40 },
      20261110,
      10,
    );
    const late = runModel(
      model,
      { ...params("failure"), cachedResolverPct: 100, recordTtlS: 5 },
      20261110,
      10,
    );
    expect(metricValue(early, "resolution-errors")).toBeLessThan(
      metricValue(late, "resolution-errors"),
    );
    expect(metricValue(early, "resolution-errors")).toBeGreaterThan(0);
  });

  it("preserves the seed and outage elapsed time in flags", () => {
    let frame = initModel(model, params("failure"), 7);
    const rng = createRng(7);
    for (let index = 0; index < 10; index++) {
      frame = stepModel(model, frame, params("failure"), rng);
    }
    expect(frame.flags.seed).toBe(7);
    expect(frame.flags.dnsElapsed).toBeCloseTo(1, 5);
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
    for (const metric of fast.metrics) {
      const other = stepped.metrics.find((item) => item.id === metric.id);
      expect(other?.value).toBeCloseTo(metric.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(model.params.length).toBeGreaterThanOrEqual(3);
    expect(model.params.length).toBeLessThanOrEqual(6);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(presets).toHaveLength(5);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});

function frameNode(frame: ReturnType<typeof runModel>, id: string) {
  return frame.nodes.find((node) => node.id === id);
}
