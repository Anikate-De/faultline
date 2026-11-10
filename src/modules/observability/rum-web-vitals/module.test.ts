import { describe, expect, it } from "vitest";
import {
  activeNodeIncident,
  activeThreshold,
  applyPresetFrame,
  initModel,
  runModel,
  stepModel,
  TICK,
} from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, rumModel } from "./module";
import { meta } from "./meta";

const model = rumModel;
const presets = module.sims["rum-web-vitals"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-rum-web-vitals model", () => {
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
      expect(Number.isFinite(node.throughput ?? 0)).toBe(true);
      expect(node.throughput ?? 0).toBeGreaterThanOrEqual(0);
    }
    for (const values of Object.values(frame.series)) {
      for (const point of values) {
        expect(Number.isFinite(point)).toBe(true);
        expect(point).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("loads the healthy preset with no active incident", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
    const stepped = applyPresetFrame(model, preset("healthy"), 20261110);
    expect(activeThreshold(stepped, model.thresholds)).toBeNull();
    expect(activeNodeIncident(stepped)).toBeNull();
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "lcp-p75")).toBeGreaterThan(4_000);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(activeNodeIncident(frame)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-lcp-p75-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("moves field LCP while the server p95 stays flat", () => {
    const healthy = runModel(model, params("healthy"), 20261110, 10);
    const heavy = runModel(model, { ...params("healthy"), bundleKb: 2_600 }, 20261110, 10);
    expect(metricValue(heavy, "lcp-p75")).toBeGreaterThan(metricValue(healthy, "lcp-p75"));
    expect(metricValue(heavy, "server-p95")).toBe(metricValue(healthy, "server-p95"));
  });

  it("raises LCP with a larger mobile audience", () => {
    const desktop = runModel(model, { ...params("healthy"), mobileShare: 20 }, 20261110, 10);
    const mobile = runModel(model, { ...params("healthy"), mobileShare: 95 }, 20261110, 10);
    expect(metricValue(mobile, "lcp-p75")).toBeGreaterThan(metricValue(desktop, "lcp-p75"));
  });

  it("raises CLS and INP with more third-party scripts", () => {
    const few = runModel(model, { ...params("healthy"), thirdPartyScripts: 0 }, 20261110, 10);
    const many = runModel(model, { ...params("healthy"), thirdPartyScripts: 12 }, 20261110, 10);
    expect(metricValue(many, "cls-p75")).toBeGreaterThan(metricValue(few, "cls-p75"));
    expect(metricValue(many, "inp-p75")).toBeGreaterThan(metricValue(few, "inp-p75"));
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
      expect(stepped.metrics.find((other) => other.id === item.id)?.value).toBeCloseTo(item.value, 6);
    }
  });

  it("declares the demo contract", () => {
    expect(meta.tags).toEqual(["RUM", "LCP", "CLS", "INP", "field data", "percentile"]);
    expect(model.params.length).toBe(4);
    expect(presets.length).toBe(4);
    expect(presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
