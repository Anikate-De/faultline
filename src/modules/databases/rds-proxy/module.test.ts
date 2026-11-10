import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, rdsProxyModel } from "./module";

const model = rdsProxyModel;
const presets = module.sims["rds-proxy-failover"].presets;
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

describe("databases-rds-proxy model", () => {
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

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((item) => item.health === "ok")).toBe(true);
    expect(metricValue(frame, "db-connections")).toBe(500);
  });

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "refused")).toBe(3_000);
    expect(metricValue(frame, "reconnect")).toBe(3_000);
    expect(metricValue(frame, "writer-util")).toBe(100);
    expect(node(frame, "app")?.health).toBe("crit");
    expect(node(frame, "writer")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "refused")).toBe(0);
    expect(metricValue(frame, "writer-util")).toBe(20);
    expect(frame.nodes.every((item) => item.health === "ok")).toBe(true);
  });

  it("keeps the first event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "failover-reconnect-storm").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "threshold-refused-crit").length).toBe(1);
  });

  it("moves the reconnect population from clients to the proxy pool", () => {
    const direct = runModel(model, { ...params("failure"), proxy: 0 }, 1, 10);
    const proxied = runModel(model, { ...params("failure"), proxy: 1, poolSize: 600 }, 1, 10);
    expect(metricValue(direct, "db-connections")).toBe(6_000);
    expect(metricValue(proxied, "db-connections")).toBe(600);
    expect(metricValue(direct, "refused")).toBe(3_000);
    expect(metricValue(proxied, "refused")).toBe(0);
  });

  it("flags refused connections even without a failover", () => {
    const frame = runModel(model, { ...params("healthy"), clients: 10_000, proxy: 0, failover: 0 }, 1, 10);
    expect(metricValue(frame, "refused")).toBe(4_000);
    expect(node(frame, "app")?.health).toBe("crit");
    expect(node(frame, "writer")?.health).toBe("crit");
  });

  it("labels the writer for the current state", () => {
    const steady = runModel(model, { ...params("healthy"), failover: 0 }, 1, 10);
    const failed = runModel(model, params("failure"), 1, 10);
    expect(node(steady, "writer")?.label).toContain("current primary");
    expect(node(failed, "writer")?.label).toContain("replacement");
  });

  it("still fails when the proxy pool is larger than the replacement writer", () => {
    const frame = runModel(model, params("proxy-limits"), 1, 10);
    expect(metricValue(frame, "db-connections")).toBe(3_600);
    expect(metricValue(frame, "refused")).toBe(600);
    expect(metricValue(frame, "writer-util")).toBe(100);
    expect(node(frame, "proxy")?.health).toBe("crit");
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
    expect(model.params.length).toBe(4);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
  });
});
