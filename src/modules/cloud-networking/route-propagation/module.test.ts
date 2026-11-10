import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, routePropagationModel } from "./module";

const model = routePropagationModel;
const presets = module.sims["tgw-routes"].presets;
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

describe("cloud-networking-route-propagation model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative values", () => {
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

  it("loads healthy at t=0 with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "delivery-rate")).toBe(100);
    expect(node(frame, "route-table")?.meta?.selected).toBe("inspection");
  });

  it("crosses critical within 30 simulated seconds on an asymmetric path", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "delivery-rate")).toBe(0);
    expect(metricValue(frame, "asymmetric-flows")).toBe(1_200);
    expect(metricValue(frame, "dropped-flows")).toBe(1_200);
    expect(node(frame, "route-table")?.health).toBe("crit");
    expect(node(frame, "vpn-primary")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "delivery-rate")).toBe(100);
    expect(metricValue(frame, "asymmetric-flows")).toBe(0);
    expect(metricValue(frame, "inspected-flows")).toBe(1_200);
  });

  it("lets the longest prefix win before route type", () => {
    const specific = runModel(
      model,
      { ...params("healthy"), specificPrefix: 1, staticRoute: 1, returnViaInspection: 0 },
      20261110,
      20,
    );
    expect(node(specific, "route-table")?.meta?.selected).toBe("vpn-primary");
    expect(node(specific, "route-table")?.meta?.route).toBe("10.60.4.0/24 → tgw-attach-vpn-primary");
    expect(metricValue(specific, "delivery-rate")).toBe(100);
    expect(metricValue(specific, "inspected-flows")).toBe(0);
  });

  it("lets a static /16 beat a propagated /16", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), specificPrefix: 0, staticRoute: 1 },
      20261110,
      20,
    );
    expect(node(frame, "route-table")?.meta?.selected).toBe("inspection");
    expect(metricValue(frame, "inspected-flows")).toBe(1_200);
  });

  it("uses AS path only when prefix and route type tie", () => {
    const backup = runModel(
      model,
      { ...params("healthy"), specificPrefix: 0, staticRoute: 0, vpnAsPath: 1 },
      20261110,
      20,
    );
    const primary = runModel(
      model,
      { ...params("healthy"), specificPrefix: 0, staticRoute: 0, vpnAsPath: 4 },
      20261110,
      20,
    );
    expect(node(backup, "route-table")?.meta?.selected).toBe("vpn-backup");
    expect(node(primary, "route-table")?.meta?.selected).toBe("vpn-primary");
    expect(metricValue(backup, "delivery-rate")).toBe(100);
    expect(metricValue(primary, "delivery-rate")).toBe(100);
  });

  it("marks an equal-AS-path tie as unstable", () => {
    const tie = runModel(
      model,
      { ...params("healthy"), specificPrefix: 0, staticRoute: 0, vpnAsPath: 2 },
      20261110,
      20,
    );
    expect(node(tie, "route-table")?.health).toBe("warn");
    expect(node(tie, "route-table")?.meta?.selected).toBe("vpn-primary");
  });

  it("keeps the first asymmetry event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "asymmetric-path")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "threshold-asymmetric-flows-crit")).toHaveLength(1);
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
