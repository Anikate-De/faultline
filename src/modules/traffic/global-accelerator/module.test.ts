import { describe, expect, it } from "vitest";
import { activeNodeIncident, activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { globalAcceleratorModel, module } from "./module";

const model = globalAcceleratorModel;
const presets = module.sims["global-accelerator"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
describe("traffic-global-accelerator model", () => {
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

  it("starts healthy with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    expect(frame.metrics.find((item) => item.id === "failed-requests")?.value).toBe(0);
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(frame.metrics.find((item) => item.id === "failed-requests")?.value).toBe(100);
    expect(frame.metrics.find((item) => item.id === "failover-delay")?.value).toBeGreaterThan(120);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    expect(frame.events.filter((event) => event.id === "endpoint-unhealthy").length).toBe(1);
    const done = runModel(model, params("failure"), 20261110, 340);
    expect(done.events.filter((event) => event.id === "failover-complete").length).toBe(1);
  });

  it("keeps a bounded series history for the charts", () => {
    const frame = runModel(model, params("failure"), 20261110, 20);
    const series = frame.series["p99"] ?? [];
    expect(series.length).toBeGreaterThan(100);
    expect(series.length).toBeLessThanOrEqual(120);
  });

  it("accelerator failover does not wait for the DNS TTL", () => {
    const dns = runModel(model, params("failure"), 20261110, 20);
    const ga = runModel(model, params("accelerated"), 20261110, 20);
    expect(dns.metrics.find((item) => item.id === "failover-delay")?.value).toBeGreaterThan(300);
    expect(ga.metrics.find((item) => item.id === "failover-delay")?.value).toBe(0);
    expect(ga.metrics.find((item) => item.id === "failed-requests")?.value).toBe(0);
  });

  it("the accelerator path reduces client p99 at the same RTT", () => {
    const direct = runModel(
      model,
      { ...params("healthy"), acceleratorEnabled: 0, clientRttMs: 200 },
      20261110,
      20,
    );
    const accelerated = runModel(
      model,
      { ...params("healthy"), acceleratorEnabled: 1, clientRttMs: 200 },
      20261110,
      20,
    );
    expect(direct.metrics.find((item) => item.id === "p99")?.value).toBe(215);
    expect(accelerated.metrics.find((item) => item.id === "p99")?.value).toBeLessThan(120);
  });

  it("marks the client saturated whenever p99 crosses the warning line", () => {
    const frame = runModel(model, params("peak"), 20261110, 20);
    expect(frame.metrics.find((item) => item.id === "p99")?.value).toBe(215);
    expect(frame.nodes.find((node) => node.id === "clients")?.health).toBe("warn");
  });

  it("insights reflect failover progress after the run", () => {
    const p = params("failure");
    const frame = runModel(model, p, 20261110, 340);
    const notes = model.insights(frame, p).join(" ");
    expect(notes).toContain("New connections now use the secondary");
    expect(notes).not.toContain("failover delay remain");
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
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "peak", "failure", "recovery"]),
    );
    expect(module.experiments.length).toBe(1);
    expect(module.meta.interviewQuestions).toBe(module.interview.length);
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
