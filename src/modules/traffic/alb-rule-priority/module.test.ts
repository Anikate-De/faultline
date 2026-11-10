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
import { albRulePriorityModel, module } from "./module";

const model = albRulePriorityModel;
const presets = module.sims["alb-rule-priority"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 20) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("traffic-alb-rule-priority model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
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

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "misrouted")?.value).toBe(40);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("fires the shadow event once and preserves flags", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "rule-shadowed")).toHaveLength(1);
    expect(frame.flags.shadowed).toBe(1);
    expect(frame.flags.seed).toBe(20261110);
    expect(typeof frame.flags.paramsKey).toBe("string");
  });

  it("first match wins regardless of condition specificity", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.metrics.find((item) => item.id === "v2-load")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "v2-idle")?.value).toBe(100);
    expect(valueOf("healthy", "misrouted")).toBe(0);
    expect(valueOf("healthy", "v2-load")).toBeGreaterThan(0);
  });

  it("removing the specific rule produces the same starvation", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), specificRulePresent: 0 },
      20261110,
      20,
    );
    expect(frame.metrics.find((item) => item.id === "misrouted")?.value).toBe(40);
    expect(frame.metrics.find((item) => item.id === "v2-load")?.value).toBe(0);
    const alb = frame.nodes.find((node) => node.id === "alb");
    const v2 = frame.nodes.find((node) => node.id === "v2");
    expect(alb?.sublabel).toContain("specific rule absent");
    expect(alb?.detail).toContain("not deployed");
    expect(alb?.utilization).toBeUndefined();
    expect(v2?.health).toBe("ok");
    expect(v2?.sublabel).toContain("idle");
    const event = frame.events.find((item) => item.id === "rule-shadowed");
    expect(event?.detail).toContain("does not exist");
    expect(event?.detail).not.toContain("specific rule at priority");
  });

  it("flags duplicate priorities as a conflict", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), broadPriority: 10, specificPriority: 10 },
      20261110,
      20,
    );
    expect(frame.metrics.find((item) => item.id === "priority-conflict")?.value).toBe(1);
    expect(frame.metrics.find((item) => item.id === "misrouted")?.value).toBe(40);
  });

  it("runs the experiment on the shadowed order it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "predict-first-match");
    expect(experiment?.setup.broadPriority).toBe(10);
    expect(experiment?.setup.specificPriority).toBe(20);
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
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.interview.length).toBe(module.meta.interviewQuestions);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
