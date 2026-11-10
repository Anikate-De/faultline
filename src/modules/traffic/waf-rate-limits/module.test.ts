import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { wafRateLimitsModel, module } from "./module";

const model = wafRateLimitsModel;
const presets = module.sims["waf-rate-limits"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("traffic-waf-rate-limits model", () => {
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
    for (const node of frame.nodes) {
      expect(Number.isFinite(node.utilization ?? 0)).toBe(true);
      expect(node.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(node.utilization ?? 0).toBeLessThanOrEqual(1);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("loads the healthy preset with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metric(frame, "false-positive")).toBeGreaterThan(30);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event and fires the false-positive spike once", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "threshold-false-positive-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "false-positive-spike").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["false-positive"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("all-path scope increases false positives compared with login-only scope", () => {
    const login = runModel(model, params("peak"), 20261110, 10);
    const allPaths = runModel(model, { ...params("peak"), scope: 0 }, 20261110, 10);
    expect(metric(allPaths, "false-positive")).toBeGreaterThan(metric(login, "false-positive"));
  });

  it("count mode records matches without blocking the attack", () => {
    const counted = runModel(model, { ...params("failure"), action: 0 }, 20261110, 10);
    expect(metric(counted, "false-positive")).toBe(0);
    expect(metric(counted, "attack-pass")).toBe(100);
    expect(metric(counted, "login-load")).toBeGreaterThan(4_000);
  });

  it("a distributed attack can sit at a per-IP threshold and pass", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-distributed-attack");
    const frame = runModel(model, experiment?.setup ?? params("failure"), 20261110, 10);
    expect(metric(frame, "attack-pass")).toBe(100);
    expect(metric(frame, "login-load")).toBeGreaterThan(20_000);
    expect(metric(frame, "p99")).toBeGreaterThan(800);
  });

  it("a tuned login rule blocks the attack without blocking legitimate traffic", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-distributed-attack");
    const frame = runModel(model, experiment?.fix ?? params("recovery"), 20261110, 10);
    expect(metric(frame, "attack-pass")).toBe(0);
    expect(metric(frame, "false-positive")).toBe(0);
    expect(metric(frame, "login-load")).toBeLessThan(4_000);
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
    expect(model.params.length).toBe(5);
    expect(module.sims["waf-rate-limits"].alternateVisuals).toContain("timeline");
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.experiments.length).toBe(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
