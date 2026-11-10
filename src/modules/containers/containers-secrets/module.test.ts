import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, secretsModel } from "./module";

const model = secretsModel;
const presets = module.sims["secrets"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const valueOf = (id: string, metricId: string, seconds = 10) =>
  runModel(model, params(id), 20261110, seconds).metrics.find((item) => item.id === metricId)?.value ?? 0;

describe("containers-secrets model", () => {
  it("is deterministic for the same seed and parameters", () => {
    const a = runModel(model, params("failure"), 42, 30);
    const b = runModel(model, params("failure"), 42, 30);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never reports NaN, Infinity, or invalid utilization", () => {
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
  });

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    const running = runModel(model, params("healthy"), 20261110, 1);
    expect(activeThreshold(running, model.thresholds)).toBeNull();
    expect(activeNodeIncident(running)).toBeNull();
  });

  it("crosses a critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(valueOf("failure", "secret-exposure")).toBeGreaterThanOrEqual(50);
    expect(valueOf("failure", "rotation-age")).toBeGreaterThanOrEqual(90);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(valueOf("recovery", "secret-exposure")).toBe(0);
    expect(valueOf("recovery", "rotation-age")).toBeLessThan(30);
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-secret-exposure-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("separates a plaintext revision from a managed reference", () => {
    const plaintext = runModel(
      model,
      { ...params("healthy"), secretSource: 0, credentialAgeDays: 10, logPolicy: 0, accessScope: 0 },
      3,
      5,
    );
    expect(plaintext.metrics.find((item) => item.id === "secret-exposure")?.value).toBe(80);
    expect(plaintext.metrics.find((item) => item.id === "plaintext-references")?.value).toBe(1);
    const managed = runModel(
      model,
      { ...params("healthy"), secretSource: 2, credentialAgeDays: 10, logPolicy: 0, accessScope: 0 },
      3,
      5,
    );
    expect(managed.metrics.find((item) => item.id === "secret-exposure")?.value).toBe(0);
    expect(managed.metrics.find((item) => item.id === "plaintext-references")?.value).toBe(0);
  });

  it("treats debug logs as an exposure even with a managed secret", () => {
    const frame = runModel(
      model,
      { ...params("healthy"), secretSource: 2, credentialAgeDays: 10, logPolicy: 1, accessScope: 0 },
      3,
      5,
    );
    expect(frame.metrics.find((item) => item.id === "secret-exposure")?.value).toBe(60);
    expect(frame.nodes.find((node) => node.id === "logs")?.health).toBe("crit");
  });

  it("preserves the seed and recorded parameters across a step", () => {
    const frame = initModel(model, params("healthy"), 11);
    const next = stepModel(model, frame, params("failure"), createRng(11));
    expect(next.flags.seed).toBe(11);
    const key = String(next.flags.paramsKey);
    expect(key).toContain("secretSource");
    expect(key).toContain("credentialAgeDays");
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
    expect(presets.length).toBe(4);
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
