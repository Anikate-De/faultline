import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, route53ResolverModel } from "./module";

const model = route53ResolverModel;
const presets = module.sims["hybrid-dns"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const node = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.nodes.find((item) => item.id === id);

describe("cloud-networking-route53-resolver model", () => {
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
    for (const item of frame.nodes) {
      expect(Number.isFinite(item.utilization ?? 0)).toBe(true);
      expect(item.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(item.utilization ?? 0).toBeLessThanOrEqual(1);
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
    expect(metricValue(frame, "resolution")).toBe(0);
    expect(metricValue(frame, "resolution-failure")).toBe(100);
    expect(metricValue(frame, "timeouts")).toBe(100);
    expect(metricValue(frame, "inbound-utilization")).toBe(0);
    expect(node(frame, "inbound")?.health).toBe("down");
    expect(node(frame, "onprem-dns")?.health).toBe("ok");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "resolution")).toBe(100);
    expect(metricValue(frame, "timeouts")).toBe(0);
    expect(node(frame, "inbound")?.health).toBe("ok");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-resolution-failure-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("detects a forwarding loop from extra query volume and timeouts", () => {
    const loop = runModel(model, params("loop"), 20261110, 20);
    const healthy = runModel(model, params("healthy"), 20261110, 20);
    expect(metricValue(loop, "resolution")).toBe(0);
    expect(metricValue(loop, "timeouts")).toBe(100);
    expect(metricValue(loop, "resolver-queries")).toBe(16_000);
    expect(metricValue(healthy, "resolver-queries")).toBe(4_000);
    expect(node(loop, "resolver")?.health).toBe("crit");
  });

  it("distinguishes a missing forwarder from a missing zone association", () => {
    const noForwarder = runModel(
      model,
      { ...params("healthy"), forwardMode: 0 },
      20261110,
      20,
    );
    const noZone = runModel(
      model,
      { ...params("healthy"), zoneAssociated: 0 },
      20261110,
      20,
    );
    expect(metricValue(noForwarder, "resolution")).toBe(0);
    expect(metricValue(noZone, "resolution")).toBe(0);
    expect(node(noForwarder, "onprem-dns")?.health).toBe("crit");
    expect(node(noForwarder, "zone")?.health).toBe("ok");
    expect(node(noZone, "zone")?.health).toBe("down");
  });

  it("sizes capacity from the documented per-IP ceiling", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), inboundAzs: 1, queryRate: 12_000 },
      20261110,
      20,
    );
    expect(metricValue(frame, "resolver-capacity")).toBe(10_000);
    expect(metricValue(frame, "resolution")).toBeCloseTo(83.33, 2);
    expect(metricValue(frame, "timeouts")).toBeCloseTo(16.67, 2);
    expect(metricValue(frame, "inbound-utilization")).toBe(100);
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
