import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, rpoModel } from "./module";

const model = rpoModel;
const presets = module.sims["cross-region-failover"].presets;
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

describe("databases-cross-region-rpo model", () => {
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
    expect(metricValue(frame, "rpo-overrun")).toBe(30);
    expect(metricValue(frame, "lost-writes")).toBe(180_000);
    expect(node(frame, "primary")?.health).toBe("down");
    expect(node(frame, "replica")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "rpo-overrun")).toBe(0);
    expect(metricValue(frame, "lost-writes")).toBe(4_000);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-rpo-overrun-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "primary-region-failed").length).toBe(1);
  });

  it("scales lost writes linearly with lag", () => {
    const short = runModel(model, { ...params("failure"), replicaLag: 45 }, 20261110, 20);
    const long = runModel(model, { ...params("failure"), replicaLag: 180 }, 20261110, 20);
    expect(metricValue(short, "lost-writes")).toBe(90_000);
    expect(metricValue(long, "lost-writes")).toBe(360_000);
    expect(metricValue(long, "lost-writes")).toBe(metricValue(short, "lost-writes") * 4);
  });

  it("keeps a planned switchover at zero data loss despite lag", () => {
    const frame = runModel(model, params("switchover"), 20261110, 20);
    expect(metricValue(frame, "lost-writes")).toBe(0);
    expect(metricValue(frame, "rpo-overrun")).toBe(0);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(node(frame, "primary")?.health).toBe("ok");
  });

  it("does not breach the RPO when the failure lands inside the budget", () => {
    const frame = runModel(model, { ...params("failure"), replicaLag: 30 }, 20261110, 20);
    expect(metricValue(frame, "rpo-overrun")).toBe(0);
    expect(metricValue(frame, "lost-writes")).toBe(60_000);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("flags an RTO overrun independently of data loss", () => {
    const frame = runModel(model, { ...params("failure"), replicaLag: 30, cutoverMinutes: 35 }, 20261110, 20);
    expect(metricValue(frame, "rpo-overrun")).toBe(0);
    expect(metricValue(frame, "rto")).toBe(35);
    const active = activeThreshold(frame, model.thresholds);
    expect(active?.severity).toBe("crit");
    expect(active?.threshold.id).toBe("rto");
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
    expect(module.sims["cross-region-failover"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
