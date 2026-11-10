import type {
  MetricValue,
  Params,
  SimEdge,
  SimEvent,
  SimFrame,
  SimModel,
  SimNode,
  SimPreset,
  ThresholdSpec,
} from "./types";
import { createRng } from "@/lib/rng";

export const TICK = 0.1;
export const MAX_SERIES = 120;
export const MAX_EVENTS = 60;
export const MAX_TICKS = 3600;

export function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function validHealth(value: string): SimNode["health"] {
  return value === "warn" || value === "crit" || value === "down" ? value : "ok";
}

export function emptyFrame(t = 0): SimFrame {
  return { t, nodes: [], edges: [], metrics: [], events: [], series: {}, flags: {} };
}

export function cloneFrame(frame: SimFrame): SimFrame {
  return {
    t: frame.t,
    nodes: frame.nodes.map((n) => ({ ...n, meta: n.meta ? { ...n.meta } : undefined })),
    edges: frame.edges.map((e) => ({ ...e })),
    metrics: frame.metrics.map((m) => ({ ...m, trend: m.trend ? [...m.trend] : undefined })),
    events: frame.events.map((e) => ({ ...e })),
    series: Object.fromEntries(Object.entries(frame.series).map(([k, v]) => [k, [...v]])),
    flags: { ...frame.flags },
    summary: frame.summary,
  };
}

export function pushEvent(frame: SimFrame, event: Omit<SimEvent, "at"> & { at?: number }, window = 6): SimFrame {
  const at = event.at ?? frame.t;
  const duplicate = frame.events.some((e) => e.id === event.id && Math.abs(e.at - at) < window);
  if (duplicate) return frame;
  frame.events = [...frame.events, { ...event, at }].slice(-MAX_EVENTS);
  return frame;
}

export function recordSeries(frame: SimFrame, key: string, value: number): void {
  const next = [...(frame.series[key] ?? []), finite(value)];
  frame.series[key] = next.slice(-MAX_SERIES);
}

export function setMetric(frame: SimFrame, metric: MetricValue): void {
  const index = frame.metrics.findIndex((m) => m.id === metric.id);
  const safe: MetricValue = {
    ...metric,
    value: finite(metric.value),
    warn: metric.warn === undefined ? undefined : finite(metric.warn),
    crit: metric.crit === undefined ? undefined : finite(metric.crit),
    trend: metric.trend?.slice(-MAX_SERIES),
  };
  if (index >= 0) frame.metrics[index] = safe;
  else frame.metrics.push(safe);
  recordSeries(frame, safe.id, safe.value);
}

export function metricStatus(metric: MetricValue | undefined): "ok" | "warn" | "crit" {
  if (!metric) return "ok";
  if (metric.crit !== undefined && metric.value >= metric.crit) return "crit";
  if (metric.warn !== undefined && metric.value >= metric.warn) return "warn";
  return "ok";
}

export function thresholdStatus(value: number, threshold: ThresholdSpec): "ok" | "warn" | "crit" {
  if (value >= threshold.crit) return "crit";
  if (value >= threshold.warn) return "warn";
  return "ok";
}

export function activeThreshold(
  frame: SimFrame,
  thresholds: ThresholdSpec[],
): { severity: "warn" | "crit"; threshold: ThresholdSpec; metric: MetricValue } | null {
  let best: { severity: "warn" | "crit"; threshold: ThresholdSpec; metric: MetricValue } | null = null;
  for (const threshold of thresholds) {
    const metric = frame.metrics.find((m) => m.id === threshold.metricId);
    if (!metric) continue;
    const status = thresholdStatus(metric.value, threshold);
    if (status === "ok") continue;
    if (!best || (status === "crit" && best.severity === "warn")) {
      best = { severity: status, threshold, metric };
    }
  }
  return best;
}


export function activeNodeIncident(
  frame: SimFrame,
): { severity: "warn" | "crit"; node: SimNode } | null {
  const rank: Record<SimNode["health"], number> = { ok: 0, warn: 1, crit: 2, down: 3 };
  const worst = frame.nodes.reduce<SimNode | null>((best, node) => {
    if (!best || rank[node.health] > rank[best.health]) return node;
    return best;
  }, null);
  if (!worst || worst.health === "ok") return null;
  return { severity: worst.health === "warn" ? "warn" : "crit", node: worst };
}

export function sanitizeFrame(frame: SimFrame): SimFrame {
  frame.t = Math.max(0, finite(frame.t));
  frame.nodes = frame.nodes.map((node) => ({
    ...node,
    utilization: node.utilization === undefined ? undefined : clamp(node.utilization),
    throughput: node.throughput === undefined ? undefined : Math.max(0, finite(node.throughput)),
    capacity: node.capacity === undefined ? undefined : Math.max(0, finite(node.capacity)),
    health: validHealth(node.health),
    meta: node.meta
      ? Object.fromEntries(
          Object.entries(node.meta).map(([k, v]) => [k, typeof v === "number" ? finite(v) : v]),
        )
      : undefined,
  }));
  frame.edges = frame.edges.map((edge) => ({
    ...edge,
    rate: clamp(finite(edge.rate)),
    health: validHealth(edge.health),
  }));
  frame.metrics = frame.metrics.map((metric) => ({
    ...metric,
    value: Math.max(0, finite(metric.value)),
    trend: metric.trend?.map((v) => Math.max(0, finite(v))).slice(-MAX_SERIES),
  }));
  for (const [key, values] of Object.entries(frame.series)) {
    frame.series[key] = values.map((v) => Math.max(0, finite(v))).slice(-MAX_SERIES);
  }
  const seen: SimEvent[] = [];
  for (const event of frame.events.slice(-MAX_EVENTS)) {
    const duplicate = seen.some((e) => e.id === event.id && Math.abs(e.at - event.at) < 6);
    if (!duplicate) seen.push({ ...event, at: Math.max(0, finite(event.at)) });
  }
  frame.events = seen;
  return frame;
}

export function thresholdsToMetrics(frame: SimFrame, thresholds: ThresholdSpec[]): SimFrame {
  for (const threshold of thresholds) {
    const metric = frame.metrics.find((m) => m.id === threshold.metricId);
    if (!metric) continue;
    if (metric.warn === undefined) metric.warn = threshold.warn;
    if (metric.crit === undefined) metric.crit = threshold.crit;
  }
  return frame;
}

export function reconcileThresholds(
  previous: SimFrame,
  next: SimFrame,
  thresholds: ThresholdSpec[],
): SimFrame {
  for (const threshold of thresholds) {
    const before = previous.metrics.find((m) => m.id === threshold.metricId);
    const after = next.metrics.find((m) => m.id === threshold.metricId);
    if (!after) continue;
    const prevStatus = before ? thresholdStatus(before.value, threshold) : "ok";
    const nextStatus = thresholdStatus(after.value, threshold);
    if (nextStatus === "crit" && prevStatus !== "crit") {
      pushEvent(next, {
        id: `threshold-${threshold.id}-crit`,
        at: next.t,
        severity: "crit",
        title: threshold.title,
        detail: `${after.label} is ${after.value.toFixed(1)}${after.unit}. ${threshold.cause}`,
        metricId: threshold.metricId,
      });
    } else if (nextStatus === "warn" && prevStatus === "ok") {
      pushEvent(next, {
        id: `threshold-${threshold.id}-warn`,
        at: next.t,
        severity: "warn",
        title: `${threshold.title} approaching`,
        detail: `${after.label} crossed the warning threshold at ${after.value.toFixed(1)}${after.unit}.`,
        metricId: threshold.metricId,
      });
    } else if (nextStatus === "ok" && prevStatus !== "ok") {
      pushEvent(next, {
        id: `threshold-${threshold.id}-ok`,
        at: next.t,
        severity: "info",
        title: `Recovering: ${threshold.title}`,
        detail: `${after.label} returned below the warning threshold at ${after.value.toFixed(1)}${after.unit}.`,
        metricId: threshold.metricId,
      });
    }
  }
  return next;
}

export function setSummary(frame: SimFrame): SimFrame {
  if (frame.summary) return frame;
  const hot = [...frame.metrics].sort((a, b) => {
    const score = (m: MetricValue) => (m.crit ? m.value / m.crit : 0);
    return score(b) - score(a);
  })[0];
  frame.summary = hot
    ? `${hot.label}: ${hot.value.toFixed(0)}${hot.unit}. ${frame.nodes.filter((n) => n.health === "crit").length} critical node(s).`
    : "No metrics reported.";
  return frame;
}

export function defaultParams(model: SimModel): Params {
  return Object.fromEntries(model.params.map((p) => [p.id, p.value]));
}

export function normalizeParams(model: SimModel, params: Params): Params {
  const out: Params = { ...defaultParams(model) };
  for (const spec of model.params) {
    const raw = params[spec.id];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[spec.id] = Math.min(spec.max, Math.max(spec.min, raw));
    } else if (typeof raw === "string" || typeof raw === "boolean") {
      out[spec.id] = raw;
    }
  }
  return out;
}

export function initModel(model: SimModel, params: Params, seed: number): SimFrame {
  const safe = normalizeParams(model, params);
  const frame = model.init({ seed });
  thresholdsToMetrics(frame, model.thresholds);
  const next = sanitizeFrame(frame);
  next.flags.seed = seed;
  next.flags.presetParams = JSON.stringify(safe);
  return setSummary(next);
}

export function stepModel(
  model: SimModel,
  frame: SimFrame,
  params: Params,
  rng = createRng(1),
  dt = TICK,
): SimFrame {
  const previous = frame;
  const safeParams = normalizeParams(model, params);
  const next = sanitizeFrame(model.step(cloneFrame(frame), safeParams, dt, rng));
  next.t = finite(previous.t + dt);
  thresholdsToMetrics(next, model.thresholds);
  reconcileThresholds(previous, next, model.thresholds);
  return setSummary(sanitizeFrame(next));
}

export function runModel(
  model: SimModel,
  params: Params,
  seed: number,
  seconds: number,
): SimFrame {
  let frame = initModel(model, params, seed);
  const rng = createRng(seed);
  const ticks = Math.min(MAX_TICKS, Math.max(0, Math.round(seconds / TICK)));
  for (let i = 0; i < ticks; i++) frame = stepModel(model, frame, params, rng);
  return frame;
}

export function applyPresetFrame(
  model: SimModel,
  preset: SimPreset,
  seed: number,
): SimFrame {
  let frame = initModel(model, preset.params, seed);
  const rng = createRng(seed);
  const ticks = Math.max(1, Math.round((preset.elapsed ?? TICK) / TICK));
  for (let index = 0; index < ticks; index++) {
    frame = stepModel(model, frame, preset.params, rng);
  }
  frame.flags.preset = preset.id;
  return sanitizeFrame(frame);
}

export function edge(
  id: string,
  from: string,
  to: string,
  rate: number,
  health: SimEdge["health"] = "ok",
  label?: string,
): SimEdge {
  return { id, from, to, rate: clamp(rate), health, label };
}

export function metric(
  id: string,
  label: string,
  value: number,
  unit: string,
  warn?: number,
  crit?: number,
  format?: MetricValue["format"],
): MetricValue {
  return { id, label, value: finite(value), unit, warn, crit, format };
}
