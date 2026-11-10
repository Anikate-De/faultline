import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { linuxNetworkSaturationModel, module } from "./module";

const model = linuxNetworkSaturationModel;
const presets = module.sims["linux-network"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;

describe("foundations-linux-network-saturation model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative utilization", () => {
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
    for (const series of Object.values(frame.series)) {
      for (const point of series) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "retransmit-rate")?.value).toBeGreaterThan(3);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-retransmit-rate-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "lossy-path").length).toBe(1);
  });

  it("a lossy path is slow while the link has spare capacity", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const util = frame.metrics.find((item) => item.id === "link-util")?.value ?? 0;
    const goodputLoss = frame.metrics.find((item) => item.id === "goodput-loss")?.value ?? 0;
    const drops = frame.metrics.find((item) => item.id === "nic-drops")?.value ?? 0;
    expect(util).toBeLessThan(30);
    expect(goodputLoss).toBeGreaterThan(50);
    expect(drops).toBeLessThan(0.1);
  });

  it("NIC drain drops are independent of link utilization", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), offeredMbps: 600, nicDrainMbps: 200, flows: 80 },
      20261110,
      20,
    );
    const metric = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    expect(metric("nic-drops")).toBeGreaterThan(50);
    expect(metric("link-util")).toBeLessThan(80);
    expect(metric("link-overflow")).toBe(0);
  });

  it("link overflow is separate from NIC drain", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), offeredMbps: 2_000, linkMbps: 1_000, nicDrainMbps: 10_000, flows: 200 },
      20261110,
      20,
    );
    const metric = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    expect(metric("link-overflow")).toBeGreaterThan(1);
    expect(metric("nic-drops")).toBe(0);
    expect(metric("link-util")).toBe(100);
  });

  it("more bandwidth does not fix loss", () => {
    const base = runModel(model, params("failure"), 20261110, 20);
    const wider = runModel(model, { ...params("failure"), linkMbps: 10_000 }, 20261110, 20);
    const goodput = (frame: typeof base) => frame.metrics.find((item) => item.id === "goodput")?.value ?? 0;
    expect(goodput(wider)).toBeCloseTo(goodput(base), 0);
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
    expect(model.params.length).toBeGreaterThanOrEqual(3);
    expect(model.params.length).toBeLessThanOrEqual(6);
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
