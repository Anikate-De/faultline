import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { labModel } from "@/simulation/labModel";
import { useSimulation } from "@/simulation/engine/useSimulation";

const initial = { load: 1_000, errorRate: 1, latency: 80 };

describe("useSimulation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("plays, pauses, resets, and respects speed", () => {
    const { result } = renderHook(() => useSimulation(labModel, initial, { seed: 3 }));
    expect(result.current.frame.t).toBe(0);
    act(() => result.current.setPlaying(true));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const t1 = result.current.frame.t;
    expect(t1).toBeGreaterThan(0);
    act(() => result.current.setSpeed(2));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.frame.t).toBeGreaterThan(t1);
    act(() => result.current.setPlaying(false));
    const paused = result.current.frame.t;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.frame.t).toBe(paused);
    act(() => result.current.reset());
    expect(result.current.frame.t).toBe(0);
    expect(result.current.playing).toBe(false);
  });

  it("does not advance while the tab is hidden", () => {
    const { result } = renderHook(() => useSimulation(labModel, initial, { seed: 4 }));
    act(() => result.current.setPlaying(true));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const before = result.current.frame.t;
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.frame.t).toBe(before);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.frame.t).toBeGreaterThan(before);
    if (descriptor) Object.defineProperty(Document.prototype, "visibilityState", descriptor);
  });

  it("fast-forwards deterministically and clamps parameters", () => {
    const { result } = renderHook(() => useSimulation(labModel, initial, { seed: 8 }));
    act(() => {
      result.current.fastForward(10, { load: 999_999, errorRate: 99, latency: -5 });
    });
    expect(result.current.frame.t).toBeCloseTo(10, 1);
    const failed = result.current.frame;
    const cpu = failed.metrics.find((metric) => metric.id === "utilization")?.value ?? 0;
    expect(cpu).toBeGreaterThan(0);
    expect(cpu).toBeLessThanOrEqual(100);
  });
});
