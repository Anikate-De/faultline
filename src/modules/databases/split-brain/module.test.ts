import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, splitBrainModel } from "./module";

const model = splitBrainModel;
const presets = module.sims["split-brain"].presets;
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

describe("databases-split-brain model", () => {
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

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "dual-writer-seconds")).toBe(900);
    expect(metricValue(frame, "divergent-writes")).toBe(360_000);
    expect(metricValue(frame, "client-errors")).toBe(0);
    expect(node(frame, "node-a")?.health).toBe("crit");
    expect(node(frame, "node-b")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "dual-writer-seconds")).toBe(0);
    expect(metricValue(frame, "divergent-writes")).toBe(0);
    expect(node(frame, "node-a")?.health).toBe("down");
    expect(node(frame, "node-b")?.health).toBe("ok");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-dual-writer-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "dual-writers").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "cluster-ready").length).toBe(1);
  });

  it("shows that quorum without fencing still diverges", () => {
    const frame = runModel(model, params("quorum-only"), 20261110, 20);
    expect(metricValue(frame, "dual-writer-seconds")).toBe(600);
    expect(metricValue(frame, "divergent-writes")).toBe(240_000);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("turns divergence into bounded rejected writes when quorum and fencing are on", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(metricValue(frame, "dual-writer-seconds")).toBe(0);
    expect(metricValue(frame, "divergent-writes")).toBe(0);
    expect(metricValue(frame, "client-errors")).toBe(27_000);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
  });

  it("scales divergent writes linearly with the partition duration", () => {
    const short = runModel(model, { ...params("failure"), partitionMinutes: 5 }, 20261110, 20);
    const long = runModel(model, { ...params("failure"), partitionMinutes: 20 }, 20261110, 20);
    expect(metricValue(short, "divergent-writes")).toBe(120_000);
    expect(metricValue(long, "divergent-writes")).toBe(480_000);
    expect(metricValue(long, "divergent-writes")).toBe(metricValue(short, "divergent-writes") * 4);
  });

  it("reports no risk when there is no partition", () => {
    const frame = runModel(model, params("healthy"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "dual-writer-seconds")).toBe(0);
    expect(node(frame, "node-a")?.health).toBe("ok");
    expect(node(frame, "node-b")?.health).toBe("ok");
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
    expect(module.sims["split-brain"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
