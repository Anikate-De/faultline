import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { healthChecksModel as model, module } from "./module";

const presets = module.sims["health-checks"].presets;
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

describe("containers-health-checks model", () => {
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
    expect(valueOf("failure", "premature-restarts", 30)).toBe(3);
    expect(valueOf("failure", "traffic-loss", 30)).toBeGreaterThanOrEqual(80);
    expect(valueOf("failure", "detection-time", 30)).toBe(60);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metricOf(frame, "premature-restarts")).toBe(0);
    expect(metricOf(frame, "traffic-loss")).toBe(0);
    expect(metricOf(frame, "warmup-coverage")).toBe(100);
  });

  it("restarts when the startup outlasts grace plus detection", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), startupSeconds: 90, gracePeriod: 10, healthCheckInterval: 30, healthCheckRetries: 2 },
      3,
      5,
    );
    expect(metricOf(frame, "detection-time")).toBe(60);
    expect(metricOf(frame, "premature-restarts")).toBe(3);
    expect(metricOf(frame, "traffic-loss")).toBeGreaterThan(80);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("does not restart when the grace period covers the startup", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), startupSeconds: 90, gracePeriod: 120, healthCheckInterval: 30, healthCheckRetries: 2 },
      3,
      5,
    );
    expect(metricOf(frame, "premature-restarts")).toBe(0);
    expect(metricOf(frame, "traffic-loss")).toBe(0);
    expect(metricOf(frame, "warmup-coverage")).toBe(100);
  });

  it("removes traffic before restarting when only the grace period is short", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), startupSeconds: 75, gracePeriod: 60, healthCheckInterval: 30, healthCheckRetries: 3 },
      3,
      5,
    );
    expect(metricOf(frame, "premature-restarts")).toBe(0);
    expect(metricOf(frame, "traffic-loss")).toBe(20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(frame.nodes.find((node) => node.id === "warming")?.health).toBe("warn");
  });

  it("separates slow detection from a warm-up restart", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), healthCheckInterval: 60, healthCheckRetries: 3 },
      3,
      5,
    );
    expect(metricOf(frame, "premature-restarts")).toBe(0);
    expect(metricOf(frame, "detection-time")).toBe(180);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.nodes.find((node) => node.id === "check")?.health).toBe("crit");
  });

  it("keeps node health and metric values in agreement", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    const scheduler = frame.nodes.find((node) => node.id === "scheduler");
    const warming = frame.nodes.find((node) => node.id === "warming");
    const alb = frame.nodes.find((node) => node.id === "alb");
    expect(scheduler?.meta?.restarts).toBe(metricOf(frame, "premature-restarts"));
    expect(warming?.health).toBe("crit");
    expect(alb?.health).toBe("crit");
    expect(frame.summary).toContain("premature restarts");
  });

  it("keeps one critical event for a single threshold crossing", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-premature-restarts-crit");
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
