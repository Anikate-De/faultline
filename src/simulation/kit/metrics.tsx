import { formatMetric } from "@/lib/format";
import type { MetricValue } from "@/simulation/engine/types";
import { metricStatus } from "@/simulation/engine/frame";
import { cn } from "@/lib/format";

const statusText = {
  ok: "",
  warn: "Above warning threshold",
  crit: "Above critical threshold",
} as const;

const statusColor = {
  ok: "var(--accent)",
  warn: "var(--warn)",
  crit: "var(--critical)",
} as const;

export function Sparkline({
  values,
  tone = "var(--accent)",
  width = 120,
  height = 32,
  label,
}: {
  values: number[];
  tone?: string;
  width?: number;
  height?: number;
  label: string;
}) {
  const points = values.slice(-40);
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const path = points
    .map((value, index) => {
      const x = points.length <= 1 ? 0 : (index / (points.length - 1)) * width;
      const y = height - 3 - ((value - min) / span) * (height - 6);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <span role="img" aria-label={label} className="block">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="max-w-full">
        <path d={path || `M0,${height - 3} L${width},${height - 3}`} fill="none" stroke={tone} strokeWidth="1.75" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function MetricCard({ metric, compact = false }: { metric: MetricValue; compact?: boolean }) {
  const status = metricStatus(metric);
  const value = formatMetric(metric.value, metric.unit, metric.format);
  return (
    <div
      className={cn(
        "rounded-[10px] border bg-surface p-3",
        status === "crit"
          ? "border-[var(--tone-danger-border)] bg-[var(--tone-danger-bg)]"
          : status === "warn"
            ? "border-[var(--tone-warn-border)] bg-[var(--tone-warn-bg)]"
            : "border-border",
        compact && "p-2.5",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted">{metric.label}</p>
        {status !== "ok" ? (
          <span
            className={cn(
              "shrink-0 font-mono text-[9px] font-semibold uppercase tracking-[0.08em]",
              status === "crit" ? "text-danger" : "text-warn",
            )}
          >
            {status === "crit" ? "crit" : "warn"}
          </span>
        ) : null}
      </div>
      <p className="mt-1 font-mono text-xl tabular-nums text-text">{value}</p>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className="text-[10px] text-faint">
          {metric.warn !== undefined ? `warn ${formatMetric(metric.warn, metric.unit, metric.format)}` : ""}
          {metric.crit !== undefined ? ` · crit ${formatMetric(metric.crit, metric.unit, metric.format)}` : ""}
        </span>
        {metric.trend?.length ? (
          <Sparkline values={metric.trend} tone={statusColor[status]} width={64} height={20} label={`${metric.label} trend`} />
        ) : null}
      </div>
      {status !== "ok" ? <span className="sr-only">{statusText[status]}</span> : null}
    </div>
  );
}

export function MetricStrip({ metrics }: { metrics: MetricValue[] }) {
  const primary = metrics.slice(0, 6);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {primary.map((metric) => (
          <MetricCard key={metric.id} metric={metric} compact />
        ))}
      </div>
      <details className="rounded-[10px] border border-border bg-surface">
        <summary className="min-h-11 cursor-pointer px-3 py-2 text-xs text-muted">All metrics and thresholds</summary>
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">All simulation metrics with warning and critical thresholds</caption>
            <thead className="bg-raised text-faint">
              <tr>
                <th scope="col" className="px-3 py-2">Metric</th>
                <th scope="col" className="px-3 py-2">Value</th>
                <th scope="col" className="px-3 py-2">Warn</th>
                <th scope="col" className="px-3 py-2">Crit</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr key={metric.id} className="border-t border-border">
                  <th scope="row" className="px-3 py-2 font-normal text-muted">{metric.label}</th>
                  <td className="px-3 py-2 font-mono tabular-nums text-text">{formatMetric(metric.value, metric.unit, metric.format)}</td>
                  <td className="px-3 py-2 font-mono tabular-nums text-muted">{metric.warn === undefined ? "—" : formatMetric(metric.warn, metric.unit, metric.format)}</td>
                  <td className="px-3 py-2 font-mono tabular-nums text-muted">{metric.crit === undefined ? "—" : formatMetric(metric.crit, metric.unit, metric.format)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export function Gauge({
  value,
  max,
  label,
  unit = "",
}: {
  value: number;
  max: number;
  label: string;
  unit?: string;
}) {
  const ratio = Math.max(0, Math.min(1, value / (max || 1)));
  const radius = 44;
  const circumference = Math.PI * radius;
  const offset = circumference * (1 - ratio);
  return (
    <div className="rounded-[12px] border border-border bg-surface p-4">
      <svg viewBox="0 0 120 74" className="w-full max-w-[180px]" role="img" aria-label={`${label}: ${value.toFixed(0)}${unit} of ${max}${unit}`}>
        <path d="M 16 62 A 44 44 0 0 1 104 62" fill="none" stroke="var(--border)" strokeWidth="8" strokeLinecap="round" />
        <path
          d="M 16 62 A 44 44 0 0 1 104 62"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <p className="mt-2 font-mono text-lg tabular-nums text-text">
        {value.toFixed(0)}
        {unit}
      </p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

export function AreaChart({
  values,
  label,
  unit = "",
  warn,
  crit,
}: {
  values: number[];
  label: string;
  unit?: string;
  warn?: number;
  crit?: number;
}) {
  const points = values.slice(-60);
  const max = Math.max(...points, crit ?? 1, warn ?? 1, 1) * 1.1;
  const width = 320;
  const height = 110;
  const path = points
    .map((value, index) => {
      const x = points.length <= 1 ? 0 : (index / (points.length - 1)) * width;
      const y = height - (value / max) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const area = path ? `${path} L${width},${height} L0,${height} Z` : "";
  return (
    <figure className="rounded-[12px] border border-border bg-surface p-3">
      <figcaption className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-text">{label}</span>
        <span className="font-mono text-[10px] text-faint">last {points.length} ticks</span>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={`${label}, latest ${points.at(-1) ?? 0}${unit}. Warning ${warn ?? "none"}, critical ${crit ?? "none"}.`}>
        {warn !== undefined ? <line x1="0" x2={width} y1={height - (warn / max) * height} y2={height - (warn / max) * height} stroke="var(--warn)" strokeDasharray="3 3" strokeWidth="1" /> : null}
        {crit !== undefined ? <line x1="0" x2={width} y1={height - (crit / max) * height} y2={height - (crit / max) * height} stroke="var(--danger)" strokeDasharray="3 3" strokeWidth="1" /> : null}
        {area ? <path d={area} fill="color-mix(in srgb, var(--accent) 14%, transparent)" /> : null}
        {path ? <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.75" /> : null}
      </svg>
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-muted">Data table</summary>
        <table className="mt-1 w-full text-left text-[11px]">
          <thead className="text-faint"><tr><th className="py-1">Tick</th><th className="py-1">Value</th></tr></thead>
          <tbody>
            {points.map((value, index) => (
              <tr key={index} className="border-t border-border">
                <td className="py-0.5 font-mono text-muted">{index + 1}</td>
                <td className="py-0.5 font-mono text-text">{value.toFixed(1)}{unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

export function Heatmap({
  rows,
  label,
  max = 100,
}: {
  rows: { label: string; values: number[] }[];
  label: string;
  max?: number;
}) {
  const columns = Math.max(...rows.map((row) => row.values.length), 1);
  return (
    <figure className="rounded-[12px] border border-border bg-surface p-3">
      <figcaption className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-text">{label}</span>
        <span className="font-mono text-[10px] text-faint">last {columns} ticks</span>
      </figcaption>
      <div className="space-y-1 overflow-x-auto">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2">
            <span className="w-16 shrink-0 truncate font-mono text-[10px] text-muted">{row.label}</span>
            <div className="flex min-w-0 flex-1 gap-px">
              {Array.from({ length: columns }).map((_, index) => {
                const value = row.values[row.values.length - columns + index] ?? 0;
                const pct = Math.max(0, Math.min(1, value / max));
                return (
                  <span
                    key={index}
                    title={`${row.label}, tick ${index + 1}: ${value.toFixed(0)}`}
                    className="h-4 min-w-[3px] flex-1 rounded-[1px]"
                    style={{
                      background: `color-mix(in srgb, ${value >= 85 ? "var(--danger)" : value >= 70 ? "var(--warn)" : "var(--accent)"} ${Math.max(10, pct * 100)}%, var(--raised))`,
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-faint">
        <span>older</span>
        <span>now</span>
      </div>
      <p className="sr-only">
        {label}. {rows.map((row) => `${row.label}: ${row.values.map((value) => value.toFixed(0)).join(", ")}`).join("; ")}.
      </p>
    </figure>
  );
}
