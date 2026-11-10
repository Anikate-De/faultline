import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { meshAccessLogsModel, module } from "./module";

const model = meshAccessLogsModel;
const presets = module.sims["mesh-access-logs"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("mesh-access-logs model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts healthy and never reports NaN, Infinity, or negative metrics", () => {
    const start = runModel(model, params("healthy"), 20261110, 0);
    expect(activeThreshold(start, model.thresholds)).toBeNull();
    expect(activeNodeIncident(start)).toBeNull();
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

  it("crosses critical within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "proxy-error")).toBeGreaterThan(5);
    expect(value(frame, "app-gap")).toBeGreaterThan(30);
    expect(value(frame, "unlogged")).toBeGreaterThan(20);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("warns without failing in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "proxy-error")).toBeLessThan(5);
    expect(value(frame, "app-gap")).toBeLessThan(30);
  });

  it("shows the application gap even at full access-log sampling", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(value(frame, "app-gap")).toBe(80);
    expect(value(frame, "unlogged")).toBe(40);
    expect(value(frame, "app-error")).toBeCloseTo(2, 5);
  });

  it("recovers the unlogged metric when sampling is raised", () => {
    const frame = runModel(model, { ...params("failure"), logSampleRate: 100 }, 20261110, 30);
    expect(value(frame, "unlogged")).toBe(0);
    expect(value(frame, "app-gap")).toBe(80);
  });

  it("emits access-log events with status, upstream, and duration", () => {
    const frame = runModel(model, params("failure"), 20261110, 12);
    const logs = frame.events.filter((event) => event.id.startsWith("access-log-"));
    expect(logs.length).toBeGreaterThan(1);
    expect(logs[0].detail).toContain("upstream=");
    expect(logs[0].detail).toContain("duration=");
    expect(frame.events.filter((event) => event.id === "proxy-only-failure")).toHaveLength(1);
  });

  it("keeps events deduplicated while the failure persists", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "proxy-only-failure")).toHaveLength(1);
    expect(frame.events.filter((event) => event.id === "access-log-sampled-out")).toHaveLength(1);
  });

  it("runFor matches stepping the same number of ticks", () => {
    const seconds = 20;
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
    expect(model.params).toHaveLength(3);
    expect(presets).toHaveLength(4);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.experiments).toHaveLength(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    expect(module.meta.tags).toEqual(["access log", "status", "upstream", "timing", "flags"]);
    expect(module.meta.learningDelta).toBe(
      "Access logs record proxy-level status, upstream, timing, and flags; they explain failures before the app sees them",
    );
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
