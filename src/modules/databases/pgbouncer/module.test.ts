import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, pgbouncerModel } from "./module";

const model = pgbouncerModel;
const presets = module.sims["pgbouncer-pool"].presets;
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

describe("databases-pgbouncer model", () => {
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
    expect(metricValue(frame, "client-connections")).toBe(4_000);
    expect(metricValue(frame, "server-connections")).toBe(400);
  });

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "session-failures")).toBe(15);
    expect(metricValue(frame, "db-util")).toBe(50);
    expect(node(frame, "app")?.health).toBe("crit");
    expect(node(frame, "pgbouncer")?.health).toBe("crit");
    expect(node(frame, "postgres")?.health).toBe("ok");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "session-failures")).toBe(0);
    expect(frame.nodes.every((item) => item.health === "ok")).toBe(true);
  });

  it("keeps the first event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "session-state-broken").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "threshold-session-failures-crit").length).toBe(1);
  });

  it("multiplexes transactions but not session pooling", () => {
    const transaction = runModel(model, { ...params("healthy"), transactionPooling: 1 }, 1, 10);
    const session = runModel(model, { ...params("healthy"), transactionPooling: 0 }, 1, 10);
    expect(metricValue(transaction, "server-connections")).toBe(400);
    expect(metricValue(session, "server-connections")).toBe(400);
    expect(metricValue(session, "pool-wait")).toBe(900);
    expect(metricValue(session, "refused")).toBe(0);
  });

  it("refuses connections when the pool exceeds the database budget", () => {
    const frame = runModel(model, params("session-pooling"), 1, 10);
    expect(metricValue(frame, "server-connections")).toBe(1_000);
    expect(metricValue(frame, "db-util")).toBe(100);
    expect(metricValue(frame, "refused")).toBe(200);
    expect(metricValue(frame, "pool-wait")).toBe(300);
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
    expect(model.params.length).toBe(5);
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
