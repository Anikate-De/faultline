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
import { module, vpcModel } from "./module";

const model = vpcModel;
const presets = module.sims["vpc-path"].presets;
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

describe("cloud-networking-vpc model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or out-of-range values", () => {
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
    expect(metricValue(frame, "failed-connections")).toBe(0);
  });

  it("crosses critical within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "delivery-rate")).toBe(0);
    expect(metricValue(frame, "blackholed-routes")).toBe(2);
    expect(node(frame, "route-a")?.health).toBe("crit");
    expect(node(frame, "route-a")?.meta?.routeState).toBe("blackhole");
    expect(node(frame, "peering")?.health).toBe("down");
  });

  it("separates a missing route from a blackhole route", () => {
    const missing = runModel(model, { ...params("healthy"), routes: 0 }, 20261110, 20);
    expect(metricValue(missing, "delivery-rate")).toBe(0);
    expect(metricValue(missing, "blackholed-routes")).toBe(0);
    expect(node(missing, "route-a")?.meta?.routeState).toBe("missing");
    expect(node(missing, "route-a")?.sublabel).toBe("no peer route");
    expect(node(missing, "peering")?.health).toBe("ok");
  });

  it("keeps delivery complete at peak with a complete private path", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(metricValue(frame, "delivery-rate")).toBe(100);
    expect(metricValue(frame, "failed-connections")).toBe(0);
    expect(metricValue(frame, "blackholed-routes")).toBe(0);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "delivery-rate")).toBe(100);
    expect(metricValue(frame, "failed-connections")).toBe(0);
  });

  it("keeps the first critical event and the peering change once", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-failed-connections-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "peering-change").length).toBe(1);
  });

  it("keeps flags across steps and fires a change event only on transition", () => {
    let frame = initModel(model, params("healthy"), 99);
    const rng = createRng(99);
    for (let index = 0; index < 20; index++) {
      frame = stepModel(model, frame, params("failure"), rng);
    }
    expect(frame.flags.peering).toBe(0);
    expect(frame.flags.routes).toBe(1);
    expect(frame.events.filter((event) => event.id === "peering-change").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "threshold-blackholed-routes-crit").length).toBe(1);
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
    expect(model.params.length).toBe(3);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.experiments.length).toBe(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    expect(module.meta.tags).toEqual(["VPC", "CIDR", "route table", "gateway", "isolation"]);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
