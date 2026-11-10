import { useCallback, useEffect, useRef, useState } from "react";
import type { Params, SimFrame, SimModel, SimPreset } from "./types";
import {
  applyPresetFrame,
  clamp,
  initModel,
  MAX_TICKS,
  pushEvent,
  runModel,
  stepModel,
  TICK,
} from "./frame";
import { createRng } from "@/lib/rng";

export interface SimulationController {
  applyParams: (params: Params) => void;
  startLive: (params?: Params) => void;
  fastForward: (seconds: number, params?: Params) => SimFrame;
  pause: () => void;
  reset: () => void;
  getFrame: () => SimFrame;
  getParams: () => Params;
}

interface Options {
  seed?: number;
  autoStart?: boolean;
  initialPreset?: SimPreset;
}

export function useSimulation(
  model: SimModel,
  initialParams: Params,
  options: Options = {},
) {
  const seed = options.seed ?? 20261110;
  const [params, setParamsState] = useState<Params>(initialParams);
  const paramsRef = useRef(params);
  const [frame, setFrame] = useState<SimFrame>(() =>
    options.initialPreset
      ? applyPresetFrame(model, options.initialPreset, seed)
      : initModel(model, initialParams, seed),
  );
  const frameRef = useRef(frame);
  const rngRef = useRef(createRng(seed));
  const [playing, setPlaying] = useState(options.autoStart ?? false);
  const [speed, setSpeed] = useState(1);
  const accRef = useRef(0);
  const containerRef = useRef<HTMLElement | null>(null);
  const visibleRef = useRef(true);

  useEffect(() => {
    paramsRef.current = params;
  }, [params]);
  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);

  const commit = useCallback((next: SimFrame) => {
    frameRef.current = next;
    setFrame(next);
    return next;
  }, []);

  const tickWith = useCallback(
    (nextParams: Params) => {
      const next = stepModel(model, frameRef.current, nextParams, rngRef.current);
      return commit(next);
    },
    [model, commit],
  );

  const resetTo = useCallback(
    (nextParams: Params, play: boolean) => {
      const safe = { ...nextParams };
      paramsRef.current = safe;
      setParamsState(safe);
      rngRef.current = createRng(seed);
      accRef.current = 0;
      const initial = initModel(model, safe, seed);
      const next = stepModel(model, initial, safe, createRng(seed), 0);
      commit(next);
      setPlaying(play);
    },
    [model, seed, commit],
  );

  const setParam = useCallback(
    (id: string, value: number) => {
      const next = { ...paramsRef.current, [id]: value };
      paramsRef.current = next;
      setParamsState(next);
      tickWith(next);
    },
    [tickWith],
  );

  const setParams = useCallback(
    (nextParams: Params) => {
      const next = { ...paramsRef.current, ...nextParams };
      paramsRef.current = next;
      setParamsState(next);
      tickWith(next);
    },
    [tickWith],
  );

  const applyPreset = useCallback(
    (preset: SimPreset) => {
      paramsRef.current = preset.params;
      setParamsState(preset.params);
      rngRef.current = createRng(seed);
      accRef.current = 0;
      const next = applyPresetFrame(model, preset, seed);
      pushEvent(next, {
        id: `preset-${preset.id}`,
        at: next.t,
        severity: preset.tone === "crit" ? "crit" : preset.tone === "warn" ? "warn" : "info",
        title: `Preset: ${preset.label}`,
        detail: preset.description,
      });
      commit(next);
      setPlaying(true);
    },
    [model, seed, commit],
  );

  const stepOnce = useCallback(() => {
    tickWith(paramsRef.current);
    setPlaying(false);
  }, [tickWith]);

  const reset = useCallback(() => {
    resetTo(paramsRef.current, false);
  }, [resetTo]);

  const fastForward = useCallback(
    (seconds: number, nextParams?: Params) => {
      const safe = nextParams ? { ...nextParams } : paramsRef.current;
      paramsRef.current = safe;
      setParamsState(safe);
      setPlaying(false);
      const safeSeconds = clamp(seconds, 0, 360);
      let next = initModel(model, safe, seed);
      const rng = createRng(seed);
      const ticks = Math.min(MAX_TICKS, Math.round(safeSeconds / TICK));
      for (let i = 0; i < ticks; i++) next = stepModel(model, next, safe, rng);
      return commit(next);
    },
    [model, seed, commit],
  );

  const startLive = useCallback(
    (nextParams?: Params) => {
      resetTo(nextParams ?? paramsRef.current, true);
    },
    [resetTo],
  );

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "hidden" || !visibleRef.current) return;
      accRef.current += speed;
      let loops = 0;
      while (accRef.current >= 1 && loops < 4) {
        tickWith(paramsRef.current);
        accRef.current -= 1;
        loops++;
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, speed, tickWith]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        visibleRef.current = entries.some((entry) => entry.isIntersecting);
      },
      { threshold: 0.05 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const controller: SimulationController = {
    applyParams: (next) => {
      paramsRef.current = { ...paramsRef.current, ...next };
      setParamsState(paramsRef.current);
      tickWith(paramsRef.current);
    },
    startLive,
    fastForward,
    pause: () => setPlaying(false),
    reset,
    getFrame: () => frameRef.current,
    getParams: () => paramsRef.current,
  };

  return {
    frame,
    params,
    setParam,
    setParams,
    applyPreset,
    playing,
    setPlaying,
    speed,
    setSpeed,
    reset,
    stepOnce,
    fastForward,
    startLive,
    containerRef,
    controller,
  };
}

export type SimulationApi = ReturnType<typeof useSimulation>;

export function runForTest(model: SimModel, params: Params, seconds: number): SimFrame {
  return runModel(model, params, 20261110, seconds);
}
