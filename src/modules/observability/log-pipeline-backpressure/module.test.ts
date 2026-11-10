import { describe, expect, it } from "vitest";
import { activeThreshold, initModel, runModel, stepModel, TICK } from "@/simulation/engine/frame";
import { createRng } from "@/lib/rng";
import { logPipelineModel, module } from "./module";

const model = logPipelineModel;
const presets = module.sims["log-pipeline"].presets;
const preset = (id: string) => {
  const found = presets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing preset ${id}`);
  return found;
};
const params = (id: string) => preset(id).params;
const value = (frame: ReturnType<typeof runModel>, id: string) =>
  frame.metrics.find((item) => item.id === id)?.value ?? 0;

describe("observability-log-pipeline-backpressure model", () => {
  it("loads healthy at t=0 with no active threshold or failing node", () => {
    const frame = initModel(model, params("healthy"), 20261110);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
    expect(frame.nodes.some((node) => node.health !== "ok")).toBe(false);
  });

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
    for (const values of Object.values(frame.series)) {
      for (const item of values) {
        expect(Number.isFinite(item)).toBe(true);
        expect(item).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("crosses a critical threshold within 60 simulated seconds in the failure preset", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)?.severity).toBe("crit");
    expect(value(frame, "egress-shortfall")).toBeGreaterThan(30_000);
    expect(value(frame, "error-drop")).toBeGreaterThan(2);
  });

  it("returns to ok within 60 simulated seconds in the recovery preset", () => {
    const frame = runModel(model, params("recovery"), 20261110, 60);
    expect(activeThreshold(frame, model.thresholds)).toBeNull();
  });

  it("keeps the first critical threshold event when events are deduplicated", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    const critical = frame.events.filter((event) => event.id === "threshold-egress-shortfall-crit");
    expect(critical.length).toBe(1);
    expect(critical[0].severity).toBe("crit");
  });

  it("emits the buffer overflow event once", () => {
    const frame = runModel(model, params("failure"), 20261110, 60);
    expect(frame.events.filter((event) => event.id === "agent-buffer-overflow").length).toBe(1);
  });

  it("uses a queue node and a queueDepth metric for the queue visual", () => {
    const frame = runModel(model, params("failure"), 20261110, 5);
    const queue = frame.nodes.find((node) => node.kind === "queue");
    expect(queue).toBeDefined();
    expect(queue?.throughput).not.toBe(value(frame, "queueDepth"));
    expect(value(frame, "queueDepth")).toBeGreaterThan(0);
  });

  it("loses errors when the reserve is zero and protects them when it is high", () => {
    const unsafe = runModel(model, params("failure"), 20261110, 20);
    const protectedFrame = runModel(
      model,
      { ...params("failure"), errorReserve: 25 },
      20261110,
      20,
    );
    expect(value(unsafe, "error-drop")).toBeGreaterThan(90);
    expect(value(protectedFrame, "error-drop")).toBeLessThan(value(unsafe, "error-drop"));
    expect(value(protectedFrame, "warn-drop")).toBeCloseTo(value(protectedFrame, "error-drop"), 6);
    expect(value(protectedFrame, "debug-drop")).toBeGreaterThan(value(protectedFrame, "error-drop"));
    expect(value(protectedFrame, "drop-rate")).toBeCloseTo(value(unsafe, "drop-rate"), 0);
  });

  it("a disk buffer delays drops but adds log age", () => {
    const shortRun = 5;
    const failure = runModel(model, params("failure"), 20261110, shortRun);
    const disk = runModel(
      model,
      {
        ...params("failure"),
        diskBufferMb: 512,
        errorReserve: 0,
      },
      20261110,
      shortRun,
    );
    expect(value(failure, "buffer-used")).toBeGreaterThan(90);
    expect(value(failure, "error-drop")).toBeGreaterThan(90);
    expect(value(disk, "buffer-used")).toBeLessThan(90);
    expect(value(disk, "error-drop")).toBeLessThan(1);
    expect(value(disk, "oldest-age")).toBeGreaterThan(0);
  });

  it("labels the buffer delay metric accurately", () => {
    const metricSpec = runModel(model, params("healthy"), 20261110, 1).metrics.find(
      (item) => item.id === "oldest-age",
    );
    expect(metricSpec?.label).toBe("Estimated buffer drain delay");
  });

  it("emits an event and accounts for backlog discarded when the buffer shrinks", () => {
    const before = runModel(model, params("failure"), 20261110, 10);
    expect(value(before, "queueDepth")).toBeGreaterThan(60_000);
    const frame = stepModel(
      model,
      before,
      { ...params("failure"), bufferMb: 8 },
      createRng(20261110),
    );
    expect(frame.events.some((event) => event.id === "buffer-shrink-loss")).toBe(true);
    expect(value(frame, "shrink-loss")).toBeGreaterThan(40_000);
    expect(value(frame, "queueDepth")).toBeLessThanOrEqual(16_000);
    expect(model.insights(frame, { ...params("failure"), bufferMb: 8 }).join(" ")).toContain(
      "buffered lines were discarded",
    );
  });

  it("describes full and draining buffers without claiming they are filling", () => {
    const failure = runModel(model, params("failure"), 20261110, 20);
    const full = model.insights(failure, params("failure")).join(" ");
    expect(full).toContain("buffer is full");
    expect(full).not.toContain("before it is full");

    let draining = failure;
    const rng = createRng(7);
    for (let index = 0; index < 10; index++) {
      draining = stepModel(model, draining, params("healthy"), rng);
    }
    const drainingText = model.insights(draining, params("healthy")).join(" ");
    expect(drainingText).toContain("draining, not filling");
    expect(drainingText).not.toContain("buffer is filling");

    const empty = model.insights(initModel(model, params("healthy"), 20261110), params("healthy")).join(" ");
    expect(empty).toContain("buffer is empty");
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
      const other = stepped.metrics.find((candidate) => candidate.id === item.id);
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
