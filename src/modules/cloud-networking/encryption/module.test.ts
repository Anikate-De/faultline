import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, encryptionModel } from "./module";

const model = encryptionModel;
const presets = module.sims["encryption-path"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("cloud-networking-encryption model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps every metric and series value finite and non-negative", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
    }
    for (const series of Object.values(frame.series)) {
      for (const point of series) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses critical within 30 simulated seconds with plaintext transport and storage", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "exposed")).toBeGreaterThan(0);
    expect(value(frame, "at-rest-gap")).toBe(100);
    expect(frame.nodes.find((node) => node.id === "service")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(value(frame, "exposed")).toBe(0);
    expect(value(frame, "at-rest-gap")).toBe(0);
  });

  it("keeps the database healthy when only transport is missing", () => {
    const frame = runModel(model, { ...params("failure"), atRest: 1 }, 20261110, 30);
    expect(value(frame, "exposed")).toBeGreaterThan(0);
    expect(value(frame, "at-rest-gap")).toBe(0);
    expect(frame.nodes.find((node) => node.id === "db")?.health).toBe("ok");
  });

  it("tracks the sensitive share rather than total requests", () => {
    const low = runModel(model, { ...params("failure"), sensitiveShare: 10 }, 20261110, 30);
    const high = runModel(model, { ...params("failure"), sensitiveShare: 90 }, 20261110, 30);
    expect(value(high, "exposed")).toBeGreaterThan(value(low, "exposed"));
  });

  it("deduplicates the plaintext event", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "threshold-exposed-crit").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "plaintext-sensitive").length).toBe(1);
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
    expect(model.thresholds.length).toBeGreaterThanOrEqual(2);
  });
});
