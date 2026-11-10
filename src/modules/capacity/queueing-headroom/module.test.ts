import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, queueingHeadroomModel } from "./module";

const model = queueingHeadroomModel;
const presets = module.sims["queueing-headroom"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("capacity-queueing-headroom model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 45);
    const b = runModel(model, params("failure"), 42, 45);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative values", () => {
    const frame = runModel(model, params("failure"), 7, 90);
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

  it("keeps a healthy target inside the latency budget through a zone loss", () => {
    const frame = runModel(model, params("healthy"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "p99")).toBeLessThan(300);
    expect(frame.nodes.some((node) => node.health === "down")).toBe(false);
    expect(frame.events.some((event) => event.id === "zone-failure")).toBe(false);
  });

  it("crosses critical after the zone loss in the failure preset", () => {
    const before = runModel(model, params("failure"), 20261110, 25);
    const after = runModel(model, params("failure"), 20261110, 45);
    expect(activeThreshold(before, model.thresholds)?.severity).not.toBe("crit");
    expect(activeThreshold(after, model.thresholds)?.severity).toBe("crit");
    expect(value(after, "utilization")).toBeGreaterThan(100);
    expect(value(after, "error-rate")).toBeGreaterThan(5);
    expect(hasZoneEvent(after)).toBe(true);
  });

  it("stays inside the warning band at the peak preset", () => {
    const frame = runModel(model, params("peak"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(value(frame, "p99")).toBeGreaterThan(300);
    expect(value(frame, "p99")).toBeLessThan(800);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "queueDepth")).toBeLessThan(2_000);
  });

  it("shows that variability raises latency at the same target", () => {
    const calm = runModel(
      model,
      { ...params("peak"), variabilityCv: 0.5, reservedForFailure: 30 },
      20261110,
      20,
    );
    const bursty = runModel(
      model,
      { ...params("peak"), variabilityCv: 1.9, reservedForFailure: 30 },
      20261110,
      20,
    );
    expect(value(bursty, "p99")).toBeGreaterThan(value(calm, "p99") * 2);
    expect(value(calm, "utilization")).toBeCloseTo(value(bursty, "utilization"), 6);
  });

  it("keeps the first critical event when threshold events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-p99-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
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
    expect(model.visual).toBe("queue");
    expect(hasQueueDepth(model)).toBe(true);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
  });
});

function hasZoneEvent(frame: ReturnType<typeof runModel>): boolean {
  return frame.events.some((event) => event.id === "zone-failure");
}

function hasQueueDepth(model: typeof queueingHeadroomModel): boolean {
  const frame = initModel(model, presets[0].params, 1);
  return frame.nodes.some((node) => node.kind === "queue") && frame.metrics.some((metric) => metric.id === "queueDepth");
}
