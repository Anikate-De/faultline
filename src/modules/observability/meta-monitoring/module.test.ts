import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { metaMonitoringModel, module } from "./module";

const model = metaMonitoringModel;
const presets = module.sims["meta-monitoring"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-meta-monitoring model", () => {
  it("loads healthy at t=0 with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.some((node) => node.health !== "ok")).toBe(false);
  });

  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative utilization", () => {
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
    for (const values of Object.values(frame.series)) {
      for (const item of values) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "blind-spot")).toBe(100);
    expect(value(frame, "staleness")).toBeGreaterThan(60);
    expect(value(frame, "detection-time")).toBeGreaterThan(300);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical threshold event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-blind-spot-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("emits the all-silent event once", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "metrics-silent").length).toBe(1);
  });

  it("detects a partial blind spot that aggregate staleness misses", () => {
    const frame = runModel(model, { ...params("healthy"), silentAgents: 10 }, 20261110, 20);
    expect(value(frame, "blind-spot")).toBe(10);
    expect(value(frame, "coverage")).toBe(90);
    expect(value(frame, "staleness")).toBeLessThan(30);
    expect(activeThreshold(frame, model.thresholds)?.threshold.id).toBe("blind-spot");
  });

  it("does not mark the alert path unhealthy for a partial blind spot", () => {
    const frame = runModel(model, { ...params("healthy"), silentAgents: 10 }, 20261110, 1);
    const health = (id: string) => frame.nodes.find((node) => node.id === id)?.health;
    expect(health("agent")).toBe("crit");
    expect(health("alerting")).toBe("ok");
    expect(health("pager")).toBe("ok");
  });

  it("starts the silence clock when agents go silent after a healthy period", () => {
    let frame = initModel(model, params("healthy"), 20261110);
    const rng = createRng(20261110);
    for (let index = 0; index < 200; index++) {
      frame = stepModel(model, frame, params("healthy"), rng);
    }
    const before = value(frame, "staleness");
    const silentParams = { ...params("healthy"), silentAgents: 100 };
    frame = stepModel(model, frame, silentParams, rng);
    const after = value(frame, "staleness");
    expect(after).toBeLessThan(before + 2);
    expect(after).toBeLessThan(30);
    for (let index = 0; index < 600; index++) {
      frame = stepModel(model, frame, silentParams, rng);
    }
    expect(value(frame, "staleness")).toBeGreaterThan(60);
  });

  it("a longer dead man window raises outage detection time", () => {
    const short = runModel(model, { ...params("healthy"), deadManWindow: 1 }, 20261110, 1);
    const long = runModel(model, { ...params("healthy"), deadManWindow: 10 }, 20261110, 1);
    expect(value(long, "detection-time")).toBeGreaterThan(value(short, "detection-time"));
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
      const other = stepped.metrics.find((candidate) => candidate.id === item.id);
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
