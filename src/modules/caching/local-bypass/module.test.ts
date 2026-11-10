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
import { localBypassModel, module } from "./module";

const model = localBypassModel;
const sim = module.sims["local-bypass"];
const preset = (id: string) => {
  const found = sim.presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metric = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("caching-local-bypass model", () => {
  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(metric(frame, "stale-error")).toBeLessThan(1);
  });

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

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metric(frame, "stale-error")).toBeGreaterThan(5);
    expect(metric(frame, "purge-seconds")).toBeGreaterThan(60);
    expect(frame.events.some((event) => event.id === "threshold-stale-error-crit")).toBe(true);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-stale-error-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "local-bypass-bad-value").length).toBe(1);
  });

  it("stops bad reads faster than a rolling replacement", () => {
    const rollout = runModel(model, params("failure"), 20261110, 60);
    const bypassed = runModel(model, params("recovery"), 20261110, 60);
    expect(metric(bypassed, "bypass-stop-seconds")).toBeLessThan(metric(rollout, "purge-seconds") / 10);
    expect(metric(rollout, "stale-error")).toBeGreaterThan(metric(bypassed, "stale-error"));
  });

  it("a bypass stops reads without changing when entries expire", () => {
    const noBypass = runModel(model, { ...params("healthy"), bypassCoveragePct: 0 }, 20261110, 20);
    const fullBypass = runModel(model, { ...params("healthy"), bypassCoveragePct: 100 }, 20261110, 20);
    expect(metric(fullBypass, "purge-seconds")).toBeCloseTo(metric(noBypass, "purge-seconds"), 6);
    expect(metric(fullBypass, "bypass-stop-seconds")).toBeLessThan(5);
    expect(metric(fullBypass, "stale-error")).toBeLessThan(metric(noBypass, "stale-error"));
  });

  it("a bypass shifts reads from the local cache to Redis", () => {
    const rollout = runModel(model, params("failure"), 20261110, 20);
    const bypassed = runModel(model, params("recovery"), 20261110, 20);
    expect(metric(bypassed, "redis-rps")).toBeGreaterThan(metric(rollout, "redis-rps") * 5);
    expect(metric(bypassed, "redis-p99")).toBeGreaterThan(metric(rollout, "redis-p99"));
  });

  it("the rolling replacement time follows task count and batch size", () => {
    const small = runModel(model, { ...params("healthy"), taskCount: 8 }, 20261110, 5);
    const large = runModel(model, { ...params("healthy"), taskCount: 40 }, 20261110, 5);
    expect(metric(small, "deploy-seconds")).toBe(30);
    expect(metric(large, "deploy-seconds")).toBe(150);
  });

  it("a bypass remains effective even with a long TTL", () => {
    const frame = runModel(model, params("kill-switch"), 20261110, 20);
    expect(metric(frame, "stale-error")).toBeLessThan(0.01);
    expect(metric(frame, "bypass-stop-seconds")).toBeLessThan(5);
    expect(metric(frame, "purge-seconds")).toBeGreaterThan(30);
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
    expect(sim.presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
