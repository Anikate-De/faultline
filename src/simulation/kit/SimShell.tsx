import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useDialogFocus } from "@/lib/useDialogFocus";
import { createPortal } from "react-dom";
import { useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import type { SimSpec, VisualKind } from "@/simulation/engine/types";
import type { SimulationController } from "@/simulation/engine/useSimulation";
import { useSimulation } from "@/simulation/engine/useSimulation";
import { activeNodeIncident, activeThreshold } from "@/simulation/engine/frame";
import { cn } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/Button";
import { MetricStrip } from "./metrics";
import { ParamPanel, PresetBar, SimToolbar } from "./controls";
import { CausalPanel, EventFeed, IncidentBanner, SimSummary } from "./events";
import { SimLegend, SimVisual } from "./visuals";

export function SimShell({
  spec,
  title,
  controllerRef,
  className,
}: {
  spec: SimSpec;
  title: string;
  controllerRef: RefObject<SimulationController | null>;
  className?: string;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  const healthy = spec.presets.find((preset) => preset.id === "healthy") ?? spec.presets[0];
  const {
    frame,
    params,
    setParam,
    applyPreset,
    playing,
    setPlaying,
    speed,
    setSpeed,
    reset,
    stepOnce,
    containerRef,
    controller,
  } = useSimulation(spec.model, healthy?.params ?? {}, { seed: 20261110, initialPreset: healthy });
  const [presetId, setPresetId] = useState<string | null>(healthy?.id ?? null);
  const [focusOpen, setFocusOpen] = useState(false);
  const [visual, setVisual] = useState<VisualKind>(spec.model.visual);
  const focusPanelRef = useRef<HTMLDivElement | null>(null);
  const closeFocus = useCallback(() => setFocusOpen(false), []);
  useDialogFocus(focusOpen, focusPanelRef, closeFocus);
  const incident = activeThreshold(frame, spec.model.thresholds);
  const nodeIncident = activeNodeIncident(frame);

  useEffect(() => {
    controllerRef.current = {
      ...controller,
      startLive: (params) => {
        setPresetId(null);
        controller.startLive(params);
      },
      fastForward: (seconds, params) => {
        setPresetId(null);
        return controller.fastForward(seconds, params);
      },
    };
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef, controller]);

  const visualChoices = [spec.model.visual, ...(spec.alternateVisuals ?? [])].filter(
    (item, index, list) => list.indexOf(item) === index,
  );

  const visualPanel = (
    <div className="space-y-2">
      {visualChoices.length > 1 ? (
        <div role="group" aria-label="Simulation view" className="flex flex-wrap gap-1">
          {visualChoices.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={visual === item}
              onClick={() => setVisual(item)}
              className={
                visual === item
                  ? "min-h-11 rounded-md border border-accent bg-accent/10 px-3 text-[11px] font-medium capitalize text-accent"
                  : "min-h-11 rounded-md border border-border px-3 text-[11px] capitalize text-muted hover:text-text"
              }
            >
              {item}
            </button>
          ))}
        </div>
      ) : null}
      <div className="rounded-[12px] border border-border bg-bg/30 p-2">
        <SimVisual visual={visual} frame={frame} reducedMotion={reducedMotion} active={playing} />
      </div>
    </div>
  );

  const body = (
    <div className="space-y-3">
      <SimToolbar
        playing={playing}
        onPlayPause={() => setPlaying(!playing)}
        onStep={stepOnce}
        onReset={() => {
          reset();
          setPresetId(null);
        }}
        time={frame.t}
        speed={speed}
        onSpeed={setSpeed}
        onFocus={() => setFocusOpen(true)}
      />
      <IncidentBanner frame={frame} thresholds={spec.model.thresholds} />
      <MetricStrip metrics={frame.metrics} />
      {visualPanel}
      {spec.model.legend ? <SimLegend items={spec.model.legend} /> : null}
      <SimSummary summary={frame.summary} />
      <PresetBar
        presets={spec.presets}
        activeId={presetId}
        onApply={(preset) => {
          applyPreset(preset);
          setPresetId(preset.id);
        }}
      />
      <ParamPanel
        params={spec.model.params}
        values={params}
        onChange={(id, value) => {
          setParam(id, value);
          setPresetId(null);
        }}
      />
      <CausalPanel frame={frame} insights={spec.model.insights(frame, params)} thresholds={spec.model.thresholds} />
      <EventFeed events={frame.events} />
      <p className="text-[10px] leading-snug text-faint">
        {spec.note ?? "Illustrative simulation. Values are example figures, not provider guarantees."}
      </p>
    </div>
  );

  return (
    <section
      ref={containerRef as RefObject<HTMLDivElement>}
      data-sim-ready="true"
      data-incident={incident?.severity ?? nodeIncident?.severity ?? "ok"}
      aria-label={`${title} simulator`}
      className={cn("rounded-[16px] border border-border bg-surface p-3 sm:p-4", className)}
    >
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">Simulator</p>
          <h2 className="truncate text-sm font-semibold text-text">{title}</h2>
        </div>
        <Badge tone="info" className="ml-auto">
          Illustrative
        </Badge>
      </header>
      {focusOpen ? (
        <div className="rounded-[10px] border border-border bg-raised px-3 py-2 text-xs text-muted" aria-hidden="true">
          Simulation is open in focus mode.
        </div>
      ) : (
        body
      )}
      {focusOpen
        ? createPortal(
            <div ref={focusPanelRef} className="fixed inset-0 z-[60] flex flex-col bg-bg" role="dialog" aria-modal="true" aria-label={`${title} focus mode`}>
              <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">Focus mode</p>
                  <h2 className="text-sm font-semibold text-text">{title}</h2>
                </div>
                <IconButton label="Close focus mode" onClick={() => setFocusOpen(false)} variant="secondary">
                  <X aria-hidden="true" className="size-5" />
                </IconButton>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
                <div className="mx-auto max-w-6xl">
                  <SimToolbar
                    playing={playing}
                    onPlayPause={() => setPlaying(!playing)}
                    onStep={stepOnce}
                    onReset={() => {
                      reset();
                      setPresetId(null);
                    }}
                    time={frame.t}
                    speed={speed}
                    onSpeed={setSpeed}
                    onFocus={closeFocus}
                  />
                  <div className="mt-3 space-y-3">
                    <IncidentBanner frame={frame} thresholds={spec.model.thresholds} />
                    <MetricStrip metrics={frame.metrics} />
                    {visualPanel}
                    {spec.model.legend ? <SimLegend items={spec.model.legend} /> : null}
                    <SimSummary summary={frame.summary} />
                    <PresetBar presets={spec.presets} activeId={presetId} onApply={(preset) => { applyPreset(preset); setPresetId(preset.id); }} />
                    <ParamPanel params={spec.model.params} values={params} onChange={(id, value) => { setParam(id, value); setPresetId(null); }} />
                    <CausalPanel frame={frame} insights={spec.model.insights(frame, params)} thresholds={spec.model.thresholds} />
                    <EventFeed events={frame.events} />
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
