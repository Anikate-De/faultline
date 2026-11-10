import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { module, pitrModel } from "./module";

const model = pitrModel;
const presets = module.sims["backups-pitr"].presets;
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

describe("databases-backups-pitr model", () => {
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

  it("crosses a critical threshold within 30 simulated seconds when PITR is disabled", () => {
    const frame = runModel(model, params("failure"), 20261110, 30);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(metricValue(frame, "pitr-gap")).toBe(6);
    expect(metricValue(frame, "data-loss")).toBe(21_600);
    expect(metricValue(frame, "restore-time")).toBe(45);
    expect(node(frame, "wal-archive")?.health).toBe("crit");
    expect(node(frame, "restore-target")?.health).toBe("crit");
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(metricValue(frame, "data-loss")).toBe(5);
    expect(metricValue(frame, "pitr-gap")).toBe(0);
    expect(metricValue(frame, "target-wait")).toBe(0);
    expect(node(frame, "restore-target")?.health).toBe("ok");
  });

  it("keeps one critical event when the same threshold is crossed repeatedly", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-data-loss-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
    expect(frame.events.filter((event) => event.id === "outside-retention").length).toBe(1);
    expect(frame.events.filter((event) => event.id === "backup-ready").length).toBe(1);
  });

  it("shows that archive delay blocks a target inside retention", () => {
    const frame = runModel(model, params("archive-gap"), 20261110, 20);
    expect(metricValue(frame, "pitr-gap")).toBe(0);
    expect(metricValue(frame, "data-loss")).toBe(600);
    expect(metricValue(frame, "target-wait")).toBe(240);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("warn");
    expect(node(frame, "wal-archive")?.health).toBe("warn");
  });

  it("widens data loss with base backup age when PITR cannot reach the damage", () => {
    const young = runModel(model, { ...params("failure"), baseBackupAgeHours: 3 }, 20261110, 20);
    const old = runModel(model, { ...params("failure"), baseBackupAgeHours: 12 }, 20261110, 20);
    expect(metricValue(young, "data-loss")).toBe(10_800);
    expect(metricValue(old, "data-loss")).toBe(43_200);
    expect(metricValue(old, "data-loss")).toBe(metricValue(young, "data-loss") * 4);
  });

  it("makes the exact target unreachable when the archive is behind", () => {
    const frame = runModel(
      model,
      { ...params("archive-gap"), incidentHoursAgo: 0.05, walArchiveLag: 900 },
      20261110,
      20,
    );
    expect(metricValue(frame, "target-wait")).toBe(720);
    expect(metricValue(frame, "data-loss")).toBe(900);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
  });

  it("keeps restore time independent of the recovery point", () => {
    const early = runModel(model, { ...params("failure"), baseBackupAgeHours: 2 }, 20261110, 20);
    const late = runModel(model, { ...params("failure"), baseBackupAgeHours: 20 }, 20261110, 20);
    expect(metricValue(early, "restore-time")).toBe(metricValue(late, "restore-time"));
    expect(metricValue(early, "data-loss")).toBeLessThan(metricValue(late, "data-loss"));
  });

  it("runFor matches stepping the same number of ticks", () => {
    const seconds = 12;
    const fast = runModel(model, params("archive-gap"), 99, seconds);
    let stepped = initModel(model, params("archive-gap"), 99);
    const rng = createRng(99);
    for (let index = 0; index < seconds / TICK; index++) {
      stepped = stepModel(model, stepped, params("archive-gap"), rng);
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
    expect(module.sims["backups-pitr"].presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(["healthy", "failure", "recovery"]),
    );
    for (const threshold of model.thresholds) {
      expect(threshold.cause.length).toBeGreaterThan(10);
      expect(threshold.fix.length).toBeGreaterThan(10);
      expect(threshold.checkFirst?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
