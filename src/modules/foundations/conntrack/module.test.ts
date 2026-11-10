import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { conntrackModel, module } from "./module";

const model = conntrackModel;
const presets = module.sims.conntrack.presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const metricValue = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((metric) => metric.id === id)?.value ?? 0;

describe("foundations-conntrack model", () => {
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

  it("crosses the tracking-table critical threshold within 30 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "table-utilization")).toBe(100);
    expect(metricValue(frame, "tracked-entries")).toBeLessThanOrEqual(262_144);
    expect(metricValue(frame, "demanded-entries")).toBeGreaterThan(262_144);
    expect(metricValue(frame, "drop-rate")).toBeGreaterThan(50);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-table-utilization-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("shows that a shorter timeout lowers occupancy but forgets active flows", () => {
    const base = params("failure");
    const shortened = { ...base, entryTimeout: 60 };
    const long = runModel(model, base, 9, 20);
    const short = runModel(model, shortened, 9, 20);
    expect(metricValue(short, "table-utilization")).toBeLessThan(metricValue(long, "table-utilization"));
    expect(metricValue(short, "broken-flows")).toBeGreaterThan(metricValue(long, "broken-flows"));
  });

  it("keeps broken flows below the new-flow rate", () => {
    const frame = runModel(model, params("timeout-cut"), 20261110, 20);
    expect(metricValue(frame, "broken-flows")).toBeLessThanOrEqual(metricValue(frame, "new-connections"));
  });

  it("shows forgotten flows in node health and event severity", () => {
    const frame = runModel(model, params("timeout-cut"), 20261110, 20);
    expect(metricValue(frame, "broken-flows")).toBeGreaterThan(500);
    expect(frame.nodes.find((node) => node.id === "nat")?.health).toBe("crit");
    const event = frame.events.find((item) => item.id === "conntrack-timeout-short");
    expect(event?.severity).toBe("crit");
  });

  it("accounts for both directions by using two entries per flow", () => {
    const frame = runModel(model, params("healthy"), 3, 20);
    const entries = metricValue(frame, "tracked-entries");
    const flows = (frame.metrics.find((metric) => metric.id === "new-connections")?.value ?? 0) * 120;
    expect(entries).toBeCloseTo(flows * 2, 0);
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
