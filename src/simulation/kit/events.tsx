import type { ReactNode } from "react";
import { AlertOctagon, AlertTriangle, Info, CheckCircle2, ChevronRight } from "lucide-react";
import type { SimEvent, SimFrame, ThresholdSpec } from "@/simulation/engine/types";
import type { MetricValue } from "@/simulation/engine/types";
import { activeNodeIncident, activeThreshold } from "@/simulation/engine/frame";
import { formatClock, formatMetric, cn } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";

export function IncidentBanner({
  frame,
  thresholds,
}: {
  frame: SimFrame;
  thresholds: ThresholdSpec[];
}) {
  const active = activeThreshold(frame, thresholds);
  const nodeIncident = activeNodeIncident(frame);
  if (!active && !nodeIncident) {
    return (
      <div className="flex items-center gap-2 rounded-[10px] border border-[var(--tone-success-border)] bg-[var(--tone-success-bg)] px-3 py-2" role="status">
        <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
        <p className="text-xs font-medium text-success">Healthy. No threshold is crossed.</p>
      </div>
    );
  }
  if (!active && nodeIncident) {
    const { node, severity } = nodeIncident;
    return (
      <section
        role="status"
        aria-live="polite"
        className={severity === "crit" ? "rounded-[10px] border border-[var(--tone-danger-border)] bg-[var(--tone-danger-bg)] p-3" : "rounded-[10px] border border-[var(--tone-warn-border)] bg-[var(--tone-warn-bg)] p-3"}
      >
        <div className="flex flex-wrap items-center gap-2">
          {severity === "crit" ? <AlertOctagon aria-hidden="true" className="size-4 text-danger" /> : <AlertTriangle aria-hidden="true" className="size-4 text-warn" />}
          <Badge tone={severity === "crit" ? "danger" : "warn"}>{severity === "crit" ? "Critical" : "Warning"}</Badge>
          <h3 className={severity === "crit" ? "text-sm font-semibold text-danger" : "text-sm font-semibold text-warn"}>
            {node.health === "down" ? "Node unavailable" : "Node failing"}: {node.label}
          </h3>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          {node.detail ?? `${node.label} is ${node.health === "down" ? "unavailable" : "not healthy"}. No metric threshold has crossed yet.`}
        </p>
        <div className="mt-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-faint">Check first</p>
          <ul className="mt-1 space-y-0.5 text-xs text-text">
            {["Inspect the node and its recent changes.", "Confirm whether it should be removed from rotation.", "Check the metric that feeds its health."].map((check) => (
              <li key={check} className="flex min-w-0 gap-1.5 break-words">
                <ChevronRight aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-accent" />
                {check}
              </li>
            ))}
          </ul>
        </div>
      </section>
    );
  }
  if (!active) return null;
  const { threshold, metric, severity } = active;
  const checks = threshold.checkFirst ?? [
    "Confirm the metric and the affected node.",
    "Compare with the last healthy window.",
    "Check the dependency that feeds this metric.",
  ];
  return (
    <section
      aria-live="off"
      className={cn(
        "rounded-[10px] border p-3",
        severity === "crit"
          ? "border-[var(--tone-danger-border)] bg-[var(--tone-danger-bg)]"
          : "border-[var(--tone-warn-border)] bg-[var(--tone-warn-bg)]",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {severity === "crit" ? (
          <AlertOctagon aria-hidden="true" className="size-4 text-danger" />
        ) : (
          <AlertTriangle aria-hidden="true" className="size-4 text-warn" />
        )}
        <Badge tone={severity === "crit" ? "danger" : "warn"}>
          {severity === "crit" ? "Critical" : "Warning"}
        </Badge>
        <h3 className={cn("text-sm font-semibold", severity === "crit" ? "text-danger" : "text-warn")}>
          {threshold.title}
        </h3>
        <span className="ml-auto font-mono text-[10px] tabular-nums text-muted">
          {formatMetric(metric.value, metric.unit, metric.format)} at {formatClock(frame.t)}
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">{threshold.cause}</p>
      <p className="sr-only" role="status" aria-live="polite">
        {severity === "crit" ? "Critical" : "Warning"}: {threshold.title}
      </p>
      <div className="mt-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-faint">Check first</p>
        <ul className="mt-1 space-y-0.5 text-xs text-text">
          {checks.map((check) => (
            <li key={check} className="flex min-w-0 gap-1.5 break-words">
              <ChevronRight aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-accent" />
              {check}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function EventFeed({ events }: { events: SimEvent[] }) {
  const visible = [...events].reverse().slice(0, 24);
  return (
    <section aria-label="Simulation events" className="rounded-[10px] border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-faint">Event feed</h3>
        <span className="font-mono text-[10px] text-faint">{events.length} events</span>
      </div>
      <div role="log" aria-live="off" tabIndex={0} aria-label="Simulation event log" className="max-h-48 space-y-1 overflow-y-auto p-2">
        <ol className="space-y-1">
        {visible.length === 0 ? (
          <li className="px-2 py-3 text-xs text-muted">No events yet. Apply a preset or raise the load.</li>
        ) : null}
        {visible.map((event) => (
          <li key={`${event.id}-${event.at}`} className="flex gap-2 rounded-md px-2 py-1.5">
            {event.severity === "crit" ? (
              <AlertOctagon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-danger" />
            ) : event.severity === "warn" ? (
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warn" />
            ) : (
              <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-info" />
            )}
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-1.5 text-xs">
                <span className="font-mono text-[10px] tabular-nums text-faint">{formatClock(event.at)}</span>
                <span className="font-medium text-text">{event.title}</span>
              </p>
              <p className="text-[11px] leading-snug text-muted">{event.detail}</p>
            </div>
          </li>
        ))}
        </ol>
      </div>
    </section>
  );
}

export function CausalPanel({
  frame,
  insights,
  thresholds,
}: {
  frame: SimFrame;
  insights: string[];
  thresholds: ThresholdSpec[];
}) {
  const active = activeThreshold(frame, thresholds);
  return (
    <details className="rounded-[10px] border border-border bg-surface">
      <summary className="min-h-11 cursor-pointer px-3 py-2 text-xs font-medium text-text">
        Why is this happening?
      </summary>
      <div className="border-t border-border px-3 py-2 text-xs leading-relaxed text-muted">
        <ul className="space-y-1.5">
          {insights.map((insight) => (
            <li key={insight} className="flex gap-2">
              <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
              {insight}
            </li>
          ))}
        </ul>
        {active ? (
          <div className="mt-3 rounded-md border border-border bg-raised p-2">
            <p className="font-medium text-text">Fix path</p>
            <p className="mt-0.5">{active.threshold.fix}</p>
          </div>
        ) : null}
      </div>
    </details>
  );
}

export function SimSummary({ summary }: { summary?: string }) {
  return (
    <p className="rounded-[8px] border border-border bg-raised px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">
      {summary ?? "Simulation ready."}
    </p>
  );
}

export function Annotation({
  title,
  tone = "info",
  children,
}: {
  title: string;
  tone?: "info" | "warn" | "danger" | "success";
  children: ReactNode;
}) {
  const styles = {
    info: "border-[var(--tone-info-border)] bg-[var(--tone-info-bg)] text-info",
    warn: "border-[var(--tone-warn-border)] bg-[var(--tone-warn-bg)] text-warn",
    danger: "border-[var(--tone-danger-border)] bg-[var(--tone-danger-bg)] text-danger",
    success: "border-[var(--tone-success-border)] bg-[var(--tone-success-bg)] text-success",
  };
  return (
    <aside className={cn("max-w-sm rounded-[10px] border p-3 text-xs leading-relaxed", styles[tone])}>
      <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em]">{title}</p>
      <div className="text-muted">{children}</div>
    </aside>
  );
}

export function MetricLegend({ metric }: { metric?: MetricValue }) {
  if (!metric) return null;
  return (
    <p className="font-mono text-[10px] text-faint">
      {metric.label}: {formatMetric(metric.value, metric.unit, metric.format)}
    </p>
  );
}
