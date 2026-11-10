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
import { module, securityGroupsModel } from "./module";

const model = securityGroupsModel;
const presets = module.sims["alb-sg-path"].presets;
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

describe("cloud-networking-security-groups model", () => {
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

  it("loads healthy at t=0 with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "delivery-rate")).toBe(100);
    expect(metricValue(frame, "blocked-connections")).toBe(0);
    expect(metricValue(frame, "exposure-breadth")).toBe(0);
  });

  it("crosses critical within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "delivery-rate")).toBe(0);
    expect(metricValue(frame, "blocked-connections")).toBeGreaterThan(50);
    expect(metricValue(frame, "unhealthy-targets")).toBe(1);
    expect(node(frame, "target-sg")?.health).toBe("crit");
    expect(node(frame, "target")?.health).toBe("crit");
  });

  it("separates a broad working rule from an availability failure", () => {
    const open = runModel(model, params("cidr-open"), 20261110, 20);
    expect(metricValue(open, "delivery-rate")).toBe(100);
    expect(metricValue(open, "blocked-connections")).toBe(0);
    expect(metricValue(open, "unhealthy-targets")).toBe(0);
    expect(metricValue(open, "exposure-breadth")).toBe(100);
    expect(activeThreshold(open, model.thresholds)?.severity).toBe("crit");
    expect(node(open, "target")?.health).toBe("warn");
    expect(node(open, "target-sg")?.health).toBe("warn");
  });

  it("shows both sources when the target has a reference and a broad rule", () => {
    const frame = runModel(model, { ...params("healthy"), targetRef: 1, broadCidr: 1 }, 20261110, 20);
    expect(metricValue(frame, "delivery-rate")).toBe(100);
    expect(metricValue(frame, "exposure-breadth")).toBe(100);
    expect(node(frame, "target-sg")?.sublabel).toContain("0.0.0.0/0");
    expect(node(frame, "target-sg")?.sublabel).toContain("ALB SG");
    expect(node(frame, "target-sg")?.health).toBe("warn");
    expect(node(frame, "target")?.sublabel).toBe("exposed: 0.0.0.0/0");
  });

  it("blocks at the ALB when the listener rule is missing", () => {
    const frame = runModel(model, { ...params("healthy"), albIngress: 0 }, 20261110, 20);
    expect(metricValue(frame, "delivery-rate")).toBe(0);
    expect(metricValue(frame, "blocked-connections")).toBeGreaterThan(50);
    expect(node(frame, "alb")?.health).toBe("crit");
    expect(node(frame, "target-sg")?.health).toBe("ok");
  });

  it("keeps delivery complete at peak on the narrow path", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(metricValue(frame, "delivery-rate")).toBe(100);
    expect(metricValue(frame, "blocked-connections")).toBe(0);
    expect(metricValue(frame, "exposure-breadth")).toBe(0);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricValue(frame, "delivery-rate")).toBe(100);
    expect(metricValue(frame, "exposure-breadth")).toBe(0);
  });

  it("keeps the first critical event and the target reference change once", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-blocked-connections-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "target-reference-change").length).toBe(1);
  });

  it("keeps flags across steps and fires a change event only on transition", () => {
    let frame = initModel(model, params("healthy"), 99);
    const rng = createRng(99);
    for (let index = 0; index < 20; index++) {
      frame = stepModel(model, frame, params("failure"), rng);
    }
    expect(frame.flags.targetRef).toBe(0);
    expect(frame.flags.broadCidr).toBe(0);
    expect(frame.events.filter((event) => event.id === "target-reference-change").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "threshold-blocked-connections-crit").length).toBe(1);
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
    expect(model.params.length).toBe(4);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "cidr-open"]),
    );
    expect(module.experiments.length).toBe(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    expect(module.meta.tags).toEqual(["security group", "stateful", "inbound", "reference", "allow list"]);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
