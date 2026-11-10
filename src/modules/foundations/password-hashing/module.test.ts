import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, passwordModel } from "./module";

const model = passwordModel;
const presets = module.sims.password.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((metric) => metric.id === id)?.value ?? 0;

describe("foundations-password-hashing model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or negative values", () => {
    const frame = runModel(model, params("failure"), 7, 60);
    for (const item of frame.metrics) {
      expect(Number.isFinite(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(0);
      if (item.id === "cracked-share") expect(item.value).toBeLessThanOrEqual(100);
    }
    for (const node of frame.nodes) {
      expect(Number.isFinite(node.utilization ?? 0)).toBe(true);
      expect(node.utilization ?? 0).toBeGreaterThanOrEqual(0);
      expect(node.utilization ?? 0).toBeLessThanOrEqual(1);
    }
    for (const values of Object.values(frame.series)) {
      for (const value of values) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses the offline-cracking critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "cracked-share")).toBeGreaterThan(5);
    expect(metricValue(frame, "salt-bits")).toBe(0);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-cracked-share-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("shows that a unique salt cannot rescue a fast hash", () => {
    const base = params("failure");
    const salted = { ...base, saltBits: 128 };
    const before = runModel(model, base, 5, 20);
    const after = runModel(model, salted, 5, 20);
    expect(metricValue(after, "cracked-share")).toBeLessThan(metricValue(before, "cracked-share"));
    expect(metricValue(after, "cracked-share")).toBeGreaterThan(5);
    expect(metricValue(after, "hash-time")).toBeCloseTo(metricValue(before, "hash-time"), 5);
  });

  it("shows salt and cost together protect an adaptive hash at low entropy", () => {
    const unsalted = { ...params("healthy"), bcryptCost: 12, saltBits: 0, passwordEntropyBits: 28 };
    const salted = { ...unsalted, saltBits: 128 };
    const before = runModel(model, unsalted, 5, 20);
    const after = runModel(model, salted, 5, 20);
    expect(metricValue(before, "cracked-share")).toBeGreaterThan(90);
    expect(metricValue(after, "cracked-share")).toBeLessThan(1);
  });

  it("shows that a higher cost raises login CPU and lowers the crack share", () => {
    const base = { ...params("healthy"), loginRate: 100 };
    const higher = { ...base, bcryptCost: 13 };
    const before = runModel(model, base, 5, 20);
    const after = runModel(model, higher, 5, 20);
    expect(metricValue(after, "login-cpu")).toBeGreaterThan(metricValue(before, "login-cpu"));
    expect(metricValue(after, "cracked-share")).toBeLessThan(metricValue(before, "cracked-share"));
    expect(metricValue(after, "login-p99")).toBeGreaterThan(metricValue(before, "login-p99"));
  });

  it("keeps login p99 monotonic and capped at 30 seconds", () => {
    const rates = [50, 100, 300, 600];
    let previous = 0;
    for (const loginRate of rates) {
      const frame = runModel(model, { ...params("healthy"), loginRate }, 5, 20);
      const p99 = metricValue(frame, "login-p99");
      expect(p99).toBeGreaterThanOrEqual(previous);
      expect(p99).toBeLessThanOrEqual(30_000);
      previous = p99;
    }
  });

  it("treats a 32-bit salt as per-user, not shared", () => {
    const frame = runModel(model, params("weak-salt"), 5, 20);
    expect(metricValue(frame, "salt-bits")).toBe(32);
    expect(metricValue(frame, "cracked-share")).toBeLessThan(1);
  });

  it("keeps the no-salt preset critical", () => {
    const frame = runModel(model, params("failure"), 5, 20);
    expect(metricValue(frame, "salt-bits")).toBe(0);
    expect(metricValue(frame, "cracked-share")).toBeGreaterThan(90);
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
