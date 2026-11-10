import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, privateHostedZonesModel } from "./module";

const model = privateHostedZonesModel;
const presets = module.sims["private-zone-resolution"].presets;
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

describe("cloud-networking-private-hosted-zones model", () => {
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
    expect(metricValue(frame, "resolution")).toBe(100);
    expect(metricValue(frame, "public-exposure")).toBe(100);
    expect(metricValue(frame, "answers-public")).toBe(100);
    expect(node(frame, "public-zone")?.health).toBe("ok");
    expect(node(frame, "record")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "resolution")).toBe(100);
    expect(metricValue(frame, "public-exposure")).toBe(0);
    expect(metricValue(frame, "answers-private")).toBe(100);
    expect(node(frame, "private-zone")?.health).toBe("ok");
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-public-exposure-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("returns the private answer to an associated VPC when both records exist", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(metricValue(frame, "resolution")).toBe(100);
    expect(metricValue(frame, "answers-private")).toBe(100);
    expect(metricValue(frame, "answers-public")).toBe(0);
    expect(metricValue(frame, "public-exposure")).toBe(100);
  });

  it("does not fall back to the public record when a private zone matches without a record", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), recordPlacement: 1 },
      20261110,
      20,
    );
    expect(metricValue(frame, "resolution")).toBe(0);
    expect(metricValue(frame, "public-exposure")).toBe(100);
    expect(node(frame, "private-zone")?.health).toBe("crit");
    expect(node(frame, "record")?.health).toBe("down");
  });

  it("does not show the private zone to an unassociated VPC", () => {
    const frame = runModel(model, params("unassociated"), 20261110, 20);
    expect(metricValue(frame, "resolution")).toBe(0);
    expect(metricValue(frame, "public-exposure")).toBe(0);
    expect(node(frame, "resolver")?.health).toBe("warn");
    expect(node(frame, "private-zone")).toBeUndefined();
    expect(node(frame, "record")?.health).toBe("down");
  });

  it("lets an unassociated VPC resolve the public record", () => {
    const frame = runModel(
      model,
      { ...params("unassociated"), publicZone: 1, recordPlacement: 1 },
      20261110,
      20,
    );
    expect(metricValue(frame, "resolution")).toBe(100);
    expect(metricValue(frame, "answers-public")).toBe(100);
    expect(metricValue(frame, "public-exposure")).toBe(100);
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
