export type VisualKind =
  | "flow"
  | "shards"
  | "queue"
  | "replication"
  | "deployment"
  | "topology"
  | "heatmap"
  | "timeline"
  | "trace"
  | "histogram"
  | "custom";

export type Health = "ok" | "warn" | "crit" | "down";
export type Params = Record<string, number | string | boolean>;

export interface SpanInfo {
  start: number;
  duration: number;
  depth: number;
  kind: string;
  self?: number;
  critical?: boolean;
  missing?: boolean;
}

export interface SimNode {
  id: string;
  label: string;
  kind:
    | "client"
    | "dns"
    | "cdn"
    | "lb"
    | "service"
    | "cache"
    | "db"
    | "queue"
    | "stream"
    | "worker"
    | "storage"
    | "mesh"
    | "external";
  sublabel?: string;
  role?: "primary" | "replica" | "shard" | "instance" | "zone";
  utilization?: number;
  health: Health;
  throughput?: number;
  capacity?: number;
  detail?: string;
  meta?: Record<string, string | number>;
  span?: SpanInfo;
}

export interface SimEdge {
  id: string;
  from: string;
  to: string;
  rate: number;
  health: Health;
  label?: string;
}

export interface MetricValue {
  id: string;
  label: string;
  value: number;
  unit: string;
  warn?: number;
  crit?: number;
  format?: "number" | "percent" | "ms" | "rps" | "bytes" | "count";
  trend?: number[];
}

export interface SimEvent {
  id: string;
  at: number;
  severity: "info" | "warn" | "crit";
  title: string;
  detail: string;
  nodeId?: string;
  metricId?: string;
}

export interface HistogramBucket {
  label: string;
  count: number;
  exemplar?: { traceId: string; durationMs: number; service: string };
}

export interface HistogramData {
  buckets: HistogramBucket[];
  unit?: string;
}

export interface SimFrame {
  t: number;
  nodes: SimNode[];
  edges: SimEdge[];
  metrics: MetricValue[];
  events: SimEvent[];
  series: Record<string, number[]>;
  flags: Record<string, number | string | boolean>;
  summary?: string;
  histogram?: HistogramData;
}

export interface Rng {
  next(): number;
  between(min: number, max: number): number;
}

export interface ParamSpec {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit: string;
  scale?: "linear" | "log";
  group?: string;
  help: string;
  format?: "number" | "percent" | "ms" | "rps" | "bytes" | "count";
}

export interface ThresholdSpec {
  id: string;
  metricId: string;
  warn: number;
  crit: number;
  title: string;
  cause: string;
  fix: string;
  checkFirst?: string[];
}

export interface LegendItem {
  label: string;
  tone: "ok" | "warn" | "crit" | "down" | "info";
}

export interface SimModel {
  id: string;
  visual: VisualKind;
  params: ParamSpec[];
  init: (ctx: { seed: number }) => SimFrame;
  step: (frame: SimFrame, params: Params, dt: number, rng: Rng) => SimFrame;
  thresholds: ThresholdSpec[];
  insights: (frame: SimFrame, params: Params) => string[];
  legend?: LegendItem[];
}

export interface SimPreset {
  id: string;
  label: string;
  description: string;
  tone: "ok" | "warn" | "crit" | "info";
  params: Params;
  elapsed?: number;
}

export interface SimSpec {
  model: SimModel;
  presets: SimPreset[];
  instructions: string;
  experimentIds?: string[];
  note?: string;
  alternateVisuals?: VisualKind[];
}

export type SimState = "ok" | "warn" | "crit" | "down";
