import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { albTargetRegistrationModel as model, module } from "./module";

const presets = module.sims["alb-target-registration"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricOf = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;
const valueOf = (id: string, metricId: string, seconds = 10) =>
  metricOf(runModel(model, params(id), 20261110, seconds), metricId);

describe("containers-alb-target-registration model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("preserves the seed and caller flags across steps", () => {
    let frame = initModel(model, params("healthy"), 77);
    frame.flags.marker = "kept";
    frame = stepModel(model, frame, params("failure"));
    expect(frame.flags.seed).toBe(77);
    expect(frame.flags.marker).toBe("kept");
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
    expect(valueOf("failure", "healthy-targets", 30)).toBe(0);
    expect(valueOf("failure", "unroutable-tasks", 30)).toBe(8);
    expect(valueOf("failure", "error-rate", 30)).toBe(100);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricOf(frame, "healthy-targets")).toBe(8);
    expect(metricOf(frame, "unroutable-tasks")).toBe(0);
    expect(metricOf(frame, "error-rate")).toBe(0);
  });

  it("separates a registration failure from a health check failure", () => {
    const mismatch = runModel(model, { ...params("healthy"), targetType: 1 }, 3, 5);
    expect(metricOf(mismatch, "registration-errors")).toBe(8);
    expect(metricOf(mismatch, "healthy-targets")).toBe(0);
    expect(metricOf(mismatch, "target-health-failures")).toBe(0);

    const port = runModel(model, { ...params("healthy"), containerPort: 80 }, 3, 5);
    expect(metricOf(port, "registration-errors")).toBe(0);
    expect(metricOf(port, "target-health-failures")).toBe(8);
    expect(metricOf(port, "healthy-targets")).toBe(0);
  });

  it("treats a closed security group as a target health failure", () => {
    const frame = runModel(model, { ...params("healthy"), securityGroupOpen: 0 }, 3, 5);
    expect(metricOf(frame, "registration-errors")).toBe(0);
    expect(metricOf(frame, "healthy-targets")).toBe(0);
    expect(metricOf(frame, "target-health-failures")).toBe(8);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("keeps node health and metric values in agreement", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    const healthy = metricOf(frame, "healthy-targets");
    const targetGroup = frame.nodes.find((node) => node.id === "target-group");
    const receiving = frame.nodes.find((node) => node.id === "healthy-targets");
    expect(targetGroup?.sublabel).toContain(`${healthy} healthy`);
    expect(receiving?.meta?.healthy).toBe(healthy);
    expect(targetGroup?.health).toBe("crit");
    expect(receiving?.health).toBe("crit");
  });

  it("keeps one critical event for a single threshold crossing", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-unroutable-tasks-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
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
    expect(model.params.length).toBe(4);
    expect(presets.length).toBe(5);
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
