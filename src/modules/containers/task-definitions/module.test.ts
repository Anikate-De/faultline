import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, taskDefinitionModel } from "./module";

const model = taskDefinitionModel;
const presets = module.sims["task-definitions"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 10) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("containers-task-definitions model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
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

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(valueOf("failure", "mixed-revision")).toBeGreaterThanOrEqual(20);
    expect(valueOf("failure", "revision-gap")).toBeGreaterThanOrEqual(1);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(valueOf("recovery", "revision-gap")).toBe(0);
    expect(valueOf("recovery", "mixed-revision")).toBe(0);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-mixed-revision-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("computes the revision gap and mixed environment from the pinned revision", () => {
    const gapFrame = runModel(model, { ...params("healthy"), serviceRevision: 7, latestRevision: 9, replacedPercent: 100 }, 3, 5);
    expect(gapFrame.metrics.find((item) => item.id === "revision-gap")?.value).toBe(2);
    expect(gapFrame.metrics.find((item) => item.id === "mixed-revision")?.value).toBe(0);
    const mixedFrame = runModel(model, { ...params("healthy"), serviceRevision: 8, latestRevision: 9, replacedPercent: 40 }, 3, 5);
    expect(mixedFrame.metrics.find((item) => item.id === "mixed-revision")?.value).toBe(40);
  });

  it("keeps task counts consistent at odd replacement percentages", () => {
    const frame = runModel(model, { ...params("healthy"), replacedPercent: 5 }, 3, 5);
    const current = frame.nodes.find((node) => node.id === "task-current");
    const previous = frame.nodes.find((node) => node.id === "task-previous");
    expect(current?.meta?.tasks).toBe(1);
    expect(previous?.meta?.tasks).toBe(9);
    expect(Number(current?.meta?.tasks) + Number(previous?.meta?.tasks)).toBe(10);
    expect(frame.metrics.find((item) => item.id === "mixed-revision")?.value).toBe(10);
    expect(frame.metrics.find((item) => item.id === "previous-share")?.value).toBe(90);
  });

  it("handles revision 1 with no previous revision", () => {
    const frame = runModel(model, { ...params("healthy"), serviceRevision: 1, latestRevision: 1, replacedPercent: 40 }, 3, 5);
    expect(frame.metrics.find((item) => item.id === "mixed-revision")?.value).toBe(0);
    expect(frame.metrics.find((item) => item.id === "previous-share")?.value).toBe(0);
    expect(frame.nodes.find((node) => node.id === "task-previous")?.label).toBe("No previous revision");
    expect(frame.nodes.find((node) => node.id === "task-current")?.meta?.tasks).toBe(10);
  });

  it("reports a launch failure when the pinned revision is newer than the latest registration", () => {
    const frame = runModel(model, { ...params("healthy"), serviceRevision: 10, latestRevision: 8 }, 3, 5);
    expect(frame.metrics.find((item) => item.id === "launch-failures")?.value).toBe(100);
    expect(frame.nodes.find((node) => node.id === "task-current")?.meta?.tasks).toBe(0);
    expect(frame.nodes.find((node) => node.id === "task-previous")?.meta?.tasks).toBe(10);
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
    expect(model.params.length).toBeGreaterThanOrEqual(3);
    expect(model.params.length).toBeLessThanOrEqual(6);
    expect(presets.length).toBe(4);
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
