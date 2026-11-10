import { useId } from "react";
import { Minus, Pause, Play, Plus, RotateCcw, SkipForward, Maximize2 } from "lucide-react";
import type { ParamSpec, Params, SimPreset } from "@/simulation/engine/types";
import { formatMetric, formatClock, cn } from "@/lib/format";
import { Button, IconButton } from "@/components/ui/Button";

const presetTone: Record<SimPreset["tone"], string> = {
  ok: "border-[var(--tone-success-border)] text-success hover:bg-[var(--tone-success-bg)]",
  warn: "border-[var(--tone-warn-border)] text-warn hover:bg-[var(--tone-warn-bg)]",
  crit: "border-[var(--tone-danger-border)] text-danger hover:bg-[var(--tone-danger-bg)]",
  info: "border-[var(--tone-info-border)] text-info hover:bg-[var(--tone-info-bg)]",
};

export function ParamSlider({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const sliderId = `${id}-range`;
  const numberId = `${id}-number`;
  const display = formatMetric(value, spec.unit, spec.format);
  const clamp = (next: number) => Math.min(spec.max, Math.max(spec.min, next));
  const toSlider = (raw: number) =>
    spec.scale === "log" ? (Math.log(raw / spec.min) / Math.log(spec.max / spec.min)) * 100 : raw;
  const fromSlider = (raw: number) =>
    spec.scale === "log" ? spec.min * (spec.max / spec.min) ** (raw / 100) : raw;
  return (
    <div className="rounded-[10px] border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <label htmlFor={sliderId} className="text-sm font-medium text-text">
          {spec.label}
        </label>
        <span className="rounded bg-raised px-2 py-0.5 font-mono text-xs tabular-nums text-accent">{display}</span>
      </div>
      <p id={`${id}-help`} className="mt-0.5 text-[11px] leading-snug text-faint">
        {spec.help}
      </p>
      <input
        id={sliderId}
        type="range"
        min={spec.scale === "log" ? 0 : spec.min}
        max={spec.scale === "log" ? 100 : spec.max}
        step={spec.scale === "log" ? 0.5 : spec.step}
        value={toSlider(value)}
        aria-valuetext={`${spec.label}: ${display}`}
        aria-describedby={`${id}-help`}
        onChange={(event) => {
          const raw = Number(event.target.value);
          const next = spec.scale === "log" ? fromSlider(raw) : raw;
          onChange(clamp(Number(next.toFixed(4))));
        }}
        className="mt-3 h-11 w-full cursor-pointer accent-[var(--accent)]"
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="hidden font-mono text-[10px] text-faint min-[400px]:inline">{formatMetric(spec.min, spec.unit, spec.format)}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={`Decrease ${spec.label}`}
            onClick={() => onChange(clamp(Number((value - spec.step).toFixed(4))))}
            className="flex size-11 items-center justify-center rounded-md border border-border bg-raised text-muted hover:text-text"
          >
            <Minus aria-hidden="true" className="size-4" />
          </button>
          <label htmlFor={numberId} className="sr-only">
            {spec.label} exact value
          </label>
          <input
            id={numberId}
            type="number"
            inputMode="decimal"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={Number(value.toFixed(2))}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) onChange(clamp(next));
            }}
            className="h-11 w-16 rounded-md border border-border bg-surface px-2 text-center font-mono text-xs tabular-nums text-text sm:w-20"
          />
          <button
            type="button"
            aria-label={`Increase ${spec.label}`}
            onClick={() => onChange(clamp(Number((value + spec.step).toFixed(4))))}
            className="flex size-11 items-center justify-center rounded-md border border-border bg-raised text-muted hover:text-text"
          >
            <Plus aria-hidden="true" className="size-4" />
          </button>
        </div>
        <span className="hidden font-mono text-[10px] text-faint min-[400px]:inline">{formatMetric(spec.max, spec.unit, spec.format)}</span>
      </div>
    </div>
  );
}

export function ParamPanel({
  params,
  values,
  onChange,
}: {
  params: ParamSpec[];
  values: Params;
  onChange: (id: string, value: number) => void;
}) {
  const groups = params.reduce<Record<string, ParamSpec[]>>((acc, spec) => {
    const group = spec.group ?? "Controls";
    (acc[group] ??= []).push(spec);
    return acc;
  }, {});
  return (
    <section aria-label="Simulation parameters" className="space-y-3">
      {Object.entries(groups).map(([group, specs]) => (
        <fieldset key={group} className="space-y-2">
          <legend className="mb-1 font-mono text-[11px] uppercase tracking-[0.08em] text-faint">{group}</legend>
          {specs.map((spec) => (
            <ParamSlider
              key={spec.id}
              spec={spec}
              value={Number(values[spec.id] ?? spec.value)}
              onChange={(value) => onChange(spec.id, value)}
            />
          ))}
        </fieldset>
      ))}
    </section>
  );
}

export function PresetBar({
  presets,
  activeId,
  onApply,
}: {
  presets: SimPreset[];
  activeId: string | null;
  onApply: (preset: SimPreset) => void;
}) {
  return (
    <section aria-label="Presets" className="space-y-1.5">
      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Presets</p>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-preset={preset.id}
            aria-pressed={activeId === preset.id}
            title={preset.description}
            onClick={() => onApply(preset)}
            className={cn(
              "min-h-11 rounded-[8px] border px-2.5 text-xs font-medium transition-colors",
              presetTone[preset.tone],
              activeId === preset.id && "bg-raised",
            )}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export function SimToolbar({
  playing,
  onPlayPause,
  onStep,
  onReset,
  time,
  speed,
  onSpeed,
  onFocus,
}: {
  playing: boolean;
  onPlayPause: () => void;
  onStep: () => void;
  onReset: () => void;
  time: number;
  speed: number;
  onSpeed: (speed: number) => void;
  onFocus: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" variant={playing ? "secondary" : "primary"} onClick={onPlayPause} aria-label={playing ? "Pause simulation" : "Play simulation"}>
        {playing ? <Pause aria-hidden="true" className="size-4" /> : <Play aria-hidden="true" className="size-4" />}
        {playing ? "Pause" : "Play"}
      </Button>
      <IconButton label="Step one tick" onClick={onStep} variant="secondary">
        <SkipForward aria-hidden="true" className="size-4" />
      </IconButton>
      <IconButton label="Reset simulation" onClick={onReset} variant="secondary">
        <RotateCcw aria-hidden="true" className="size-4" />
      </IconButton>
      <div className="ml-auto flex items-center gap-1">
        <span className="font-mono text-xs tabular-nums text-muted" aria-label={`Simulated time ${formatClock(time)}`}>
          {formatClock(time)}
        </span>
        <div role="group" aria-label="Simulation speed" className="flex rounded-md border border-border bg-surface p-0.5">
          {[0.5, 1, 2, 4].map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={speed === option}
              onClick={() => onSpeed(option)}
              className={cn(
                "min-h-11 min-w-11 rounded px-1 font-mono text-[10px]",
                speed === option ? "bg-accent text-[color:var(--accent-contrast)]" : "text-muted hover:text-text",
              )}
            >
              {option}×
            </button>
          ))}
        </div>
        <IconButton label="Open focus mode" onClick={onFocus} variant="secondary">
          <Maximize2 aria-hidden="true" className="size-4" />
        </IconButton>
      </div>
    </div>
  );
}
