import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { kumaModel, module } from "./module";

const model = kumaModel;
const sim = module.sims.kuma;
const preset = (id: string) => {
  const found = sim.presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("mesh-kuma-control-plane model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("starts the healthy preset with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.every((node) => node.health === "ok")).toBe(true);
    expect(value(frame, "overmatched-proxies")).toBe(0);
    expect(value(frame, "missed-proxies")).toBe(0);
    expect(value(frame, "affected-proxies")).toBe(4);
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
      for (const item of values) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses the critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "affected-proxies")).toBe(12);
    expect(value(frame, "overmatched-proxies")).toBe(8);
    expect(value(frame, "missed-proxies")).toBe(0);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "affected-proxies")).toBe(4);
    expect(value(frame, "overmatched-proxies")).toBe(0);
    expect(value(frame, "missed-proxies")).toBe(0);
  });

  it("warns without overmatching the whole mesh in the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "affected-proxies")).toBe(8);
    expect(value(frame, "overmatched-proxies")).toBe(4);
  });

  it("misses intended workloads when the mesh boundary is wrong", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), meshMatch: 0 },
      20261110,
      10,
    );
    expect(value(frame, "missed-proxies")).toBe(2);
    expect(value(frame, "missed-share")).toBe(50);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.events.some((event) => event.id === "policy-mesh-miss")).toBe(true);
  });

  it("misses intended workloads when sidecars are too old", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), proxyCompat: 0 },
      20261110,
      10,
    );
    expect(value(frame, "missed-proxies")).toBe(2);
    expect(value(frame, "affected-proxies")).toBe(2);
  });

  it("deduplicates policy scope events", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "policy-overmatch").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "policy-missed").length).toBe(0);
    const missed = runModel(model, { ...params("healthy"), meshMatch: 0 }, 20261110, 60);
    expect(missed.events.filter((event) => event.id === "policy-missed").length).toBe(1);
    expect(missed.events.filter((event) => event.id === "policy-mesh-miss").length).toBe(1);
  });

  it("keeps metric series history for sparklines and charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 10);
    expect(frame.series["overmatched-proxies"]?.length).toBeGreaterThan(1);
    expect(frame.metrics.find((item) => item.id === "overmatched-proxies")?.trend?.length).toBeGreaterThan(1);
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
    expect(sim.presets.length).toBe(4);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
