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
import { gatewayTimeoutModel, module } from "./module";

const model = gatewayTimeoutModel;
const presets = module.sims["504-debug"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
describe("traffic-504-debug model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = runModel(model, params("healthy"), 20261110, 0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(frame.metrics.find((item) => item.id === "rate-504")?.value).toBe(0);
  });

  it("never reports NaN, Infinity, or negative metrics", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const node of frame.nodes) {
      expect(Number.isFinite(node.utilization ?? 0)).toBe(true);
      expect(node.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(node.utilization ?? 0).toBeLessThanOrEqual(1);
      expect(Number.isFinite(node.span?.duration ?? 0)).toBe(true);
      expect(node.span?.duration ?? 0).toBeGreaterThanOrEqual(0);
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
    expect(frame.metrics.find((item) => item.id === "rate-504")?.value).toBe(100);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("identifies the ALB idle timeout and orphaned upstream work", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.metrics.find((item) => item.id === "client-elapsed")?.value).toBe(60_000);
    expect(frame.metrics.find((item) => item.id === "budget-shortfall")?.value).toBe(12_000);
    expect(frame.metrics.find((item) => item.id === "orphaned-work")?.value).toBe(12);
    expect(frame.metrics.find((item) => item.id === "elb-504")?.value).toBe(1);
    expect(frame.metrics.find((item) => item.id === "target-504")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "service-log")?.value).toBe(2_000);
    expect(frame.summary).toContain("ALB idle timeout");
    expect(frame.summary).toContain("12.0s after the client gave up.");
    const timer = frame.nodes.find((node) => node.id === "timer");
    expect(timer?.label).toContain("ALB idle timeout");
    expect(frame.nodes.find((node) => node.id === "service")?.label).toBe("Service · 2.0s");
    expect(frame.nodes.find((node) => node.id === "dependency")?.label).toBe("Dependency · 70.0s");
    expect(model.insights(frame, params("failure")).join(" ")).toContain(
      "models the idle-timeout case",
    );
  });

  it("identifies a service deadline that fires before the ALB timeout", () => {
    const frame = runModel(model, params("service-timeout"), 20261110, 20);
    expect(frame.metrics.find((item) => item.id === "client-elapsed")?.value).toBe(30_000);
    expect(frame.metrics.find((item) => item.id === "elb-504")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "target-504")?.value).toBe(1);
    expect(frame.metrics.find((item) => item.id === "orphaned-work")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "upstream-p99")?.value).toBe(30_000);
    expect(frame.metrics.find((item) => item.id === "dependency-wait")?.value).toBe(27_975);
    expect(frame.metrics.find((item) => item.id === "timeout-headroom")?.value).toBe(90_000);
    expect(frame.summary).toContain("Service deadline");
    expect(frame.summary).toContain("30.0s total upstream work");
    expect(frame.events.some((item) => item.id === "service-deadline-fired")).toBe(true);
    expect(model.insights(frame, params("service-timeout")).join(" ")).not.toContain(
      "models the idle-timeout case",
    );
  });

  it("clamps observed handler work to the service deadline", () => {
    const frame = runModel(
      model,
      {
        ...params("healthy"),
        serviceWorkMs: 10_000,
        dependencyDelayMs: 0,
        serviceDeadlineMs: 1_000,
      },
      20261110,
      20,
    );
    expect(frame.metrics.find((item) => item.id === "service-log")?.value).toBe(975);
    expect(frame.metrics.find((item) => item.id === "client-elapsed")?.value).toBe(1_000);
    expect(frame.metrics.find((item) => item.id === "rate-504")?.value).toBe(100);
    expect(frame.metrics.find((item) => item.id === "upstream-p99")?.value).toBe(1_000);
    expect(frame.summary).toContain("1.0s logged work");
  });

  it("keeps the orphaned-work event to one occurrence while the condition persists", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(frame.events.filter((item) => item.id === "upstream-after-504")).toHaveLength(1);
    expect(frame.events.filter((item) => item.id === "service-deadline-fired")).toHaveLength(0);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["rate-504"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("the near-budget preset succeeds but leaves little headroom", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(frame.metrics.find((item) => item.id === "rate-504")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "timeout-headroom")?.value).toBe(3_000);
  });

  it("fixing the dependency clears the 504 at the same ALB timeout", () => {
    const fixed = runModel(model, params("recovery"), 20261110, 20);
    expect(fixed.metrics.find((item) => item.id === "rate-504")?.value).toBe(0);
    expect(fixed.metrics.find((item) => item.id === "orphaned-work")?.value).toBe(0);
    expect(fixed.metrics.find((item) => item.id === "client-elapsed")?.value).toBe(22_000);
  });

  it("runs the experiment at the timeout setup it claims to test", () => {
    const experiment = module.experiments.find((item) => item.id === "find-expired-timer");
    expect(experiment?.setup.albIdleTimeout).toBe(60);
    expect(experiment?.setup.serviceDeadlineMs).toBe(90_000);
    const frame = runModel(model, experiment?.setup ?? {}, 20261110, experiment?.runFor ?? 20);
    expect(frame.metrics.find((item) => item.id === "orphaned-work")?.value).toBeGreaterThan(0);
    expect(frame.metrics.find((item) => item.id === "elb-504")?.value).toBe(1);
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
    expect(presets).toHaveLength(5);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery", "service-timeout"]),
    );
    expect(module.experiments).toHaveLength(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    expect(module.meta.tags).toEqual(["504", "timeout", "idle timeout", "upstream", "retry", "budget"]);
    expect(module.meta.learningDelta).toBe(
      "A 504 means a timeout expired; it can be generated by the ALB or the target, and the upstream may still be working; align LB, service, and dependency budgets",
    );
    expect(model.params.find((item) => item.id === "serviceWorkMs")?.label).toBe(
      "Configured handler work",
    );
    expect(model.params.find((item) => item.id === "dependencyDelayMs")?.label).toBe(
      "Configured dependency wait",
    );
    expect(model.params.find((item) => item.id === "serviceDeadlineMs")?.help).toContain(
      "shorter timer fires first",
    );
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
