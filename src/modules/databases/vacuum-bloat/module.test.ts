import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, bloatModel } from "./module";

const model = bloatModel;
const presets = module.sims["vacuum-bloat"].presets;
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

describe("databases-vacuum-bloat model", () => {
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
    expect(metricValue(frame, "bloat")).toBeCloseTo(90, 6);
    expect(metricValue(frame, "query-p95")).toBeCloseTo(61.5, 6);
    expect(metricValue(frame, "snapshot-age")).toBe(90);
    expect(node(frame, "table")?.health).toBe("crit");
    expect(node(frame, "autovacuum")?.health).toBe("crit");
    expect(node(frame, "app")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "bloat")).toBeLessThan(25);
    expect(metricValue(frame, "query-p95")).toBeLessThan(20);
    expect(node(frame, "table")?.health).toBe("ok");
    expect(node(frame, "app")?.health).toBe("ok");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-bloat-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "snapshot-blocks-vacuum").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "table-sampled").length).toBe(1);
  });

  it("grows bloat when an old snapshot blocks cleanup", () => {
    const clear = runModel(model, { ...params("peak"), updateRate: 4_000, oldestSnapshot: 0 }, 20261110, 20);
    const blocked = runModel(model, { ...params("peak"), updateRate: 4_000, oldestSnapshot: 10 }, 20261110, 20);
    expect(metricValue(blocked, "bloat")).toBeGreaterThan(metricValue(clear, "bloat") * 2);
    expect(node(blocked, "autovacuum")?.health).toBe("crit");
    expect(metricValue(blocked, "bloat")).toBeGreaterThan(50);
  });

  it("grows bloat when vacuum runs less often, even without a snapshot", () => {
    const frequent = runModel(model, { ...params("healthy"), updateRate: 3_000, vacuumInterval: 5 }, 20261110, 20);
    const rare = runModel(model, { ...params("healthy"), updateRate: 3_000, vacuumInterval: 20 }, 20261110, 20);
    expect(metricValue(rare, "bloat")).toBeGreaterThan(metricValue(frequent, "bloat"));
    expect(metricValue(rare, "bloat")).toBeGreaterThan(25);
  });

  it("raises query latency when vacuum has less I/O headroom", () => {
    const roomy = runModel(model, { ...params("peak"), vacuumIoShare: 100 }, 20261110, 20);
    const tight = runModel(model, { ...params("peak"), vacuumIoShare: 10 }, 20261110, 20);
    expect(metricValue(tight, "query-p95")).toBeGreaterThan(metricValue(roomy, "query-p95"));
    expect(metricValue(tight, "bloat")).toBeCloseTo(metricValue(roomy, "bloat"), 6);
  });

  it("shows bloat without a snapshot when vacuum is too rare", () => {
    const frame = runModel(model, params("slow-vacuum"), 20261110, 20);
    expect(metricValue(frame, "snapshot-age")).toBe(0);
    expect(metricValue(frame, "bloat")).toBeGreaterThan(50);
    expect(node(frame, "autovacuum")?.health).toBe("ok");
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
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
    expect(module.sims["vacuum-bloat"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
