import type { Health, MetricValue, SimFrame, SimNode, VisualKind } from "@/simulation/engine/types";
import { edge, metric } from "@/simulation/engine/frame";

type LabState = "ok" | "warn" | "crit" | "down";

const stateHealth: Record<LabState, Health> = { ok: "ok", warn: "warn", crit: "crit", down: "down" };

function series(base: number, amplitude: number, state: LabState): number[] {
  const factor = state === "crit" || state === "down" ? 1.4 : state === "warn" ? 1.15 : 1;
  return Array.from({ length: 24 }, (_, index) => Math.max(0, Math.min(100, base * factor + Math.sin(index / 2.2) * amplitude)));
}

const baseMetrics = (state: LabState): MetricValue[] => [
  metric("p99", "p99 latency", state === "crit" ? 940 : state === "warn" ? 360 : 90, "ms", 300, 800, "ms"),
  metric("errorPercent", "Error rate", state === "crit" ? 7.4 : state === "warn" ? 2.4 : 0.2, "%", 2, 5, "percent"),
  metric("utilization", "Utilization", state === "crit" ? 96 : state === "warn" ? 78 : 34, "%", 70, 90, "percent"),
  metric("throughput", "Throughput", 4_800, " rps", undefined, undefined, "rps"),
  metric("queueDepth", "Queue depth", state === "crit" ? 18_000 : state === "warn" ? 2_400 : 40, "", undefined, undefined, "count"),
  metric("replicaLag", "Replica lag", state === "crit" ? 8.2 : state === "warn" ? 1.8 : 0.2, "s", 1, 5, "number"),
];

function flow(state: LabState): SimFrame {
  const health = stateHealth[state];
  const nodes: SimNode[] = [
    { id: "client", label: "Client", kind: "client", health: "ok", sublabel: "mobile + web", meta: { view: "flow" } },
    { id: "edge", label: "Edge", kind: "cdn", health: "ok", utilization: 0.3, throughput: 5_000, meta: { view: "flow" } },
    { id: "service", label: "Checkout", kind: "service", health, utilization: state === "crit" ? 0.96 : 0.42, throughput: 4_800, meta: { view: "flow" } },
    { id: "db", label: "Orders DB", kind: "db", health: state === "crit" ? "warn" : "ok", utilization: 0.55, meta: { view: "flow" } },
  ];
  return {
    t: 42,
    nodes,
    edges: [edge("a", "client", "edge", 0.8), edge("b", "edge", "service", 0.8, health), edge("c", "service", "db", 0.5, health)],
    metrics: baseMetrics(state),
    events: [
      { id: "lab-1", at: 0, severity: "info", title: "Simulation started", detail: "Lab frame loaded at nominal traffic." },
      { id: "lab-2", at: 18, severity: state === "crit" ? "crit" : "warn", title: "Threshold crossed", detail: "Checkout p99 and error rate moved together." },
      { id: "lab-3", at: 34, severity: "info", title: "Recovery began", detail: "Load was reduced and the dependency recovered." },
    ],
    series: { p99: series(90, 30, state), errorPercent: series(1, 0.6, state), utilization: series(40, 15, state) },
    flags: { state },
    summary: `Lab flow in ${state} state. p99 and error rate are the first signals.`,
  };
}

function shards(state: LabState): SimFrame {
  const factor = state === "crit" || state === "down" ? 1.2 : state === "warn" ? 1.05 : 1;
  const cpus = [94, 18, 22, 16, 21, 19, 17, 20].map((cpu, index) => Math.min(100, cpu * factor + (index === 0 ? 0 : Math.sin(index) * 2)));
  const nodes: SimNode[] = cpus.map((cpu, index) => ({
    id: `shard-${index}`,
    label: `shard-${index}`,
    kind: "cache",
    role: "shard",
    health: cpu >= 85 ? stateHealth[state === "ok" ? "crit" : state] : "ok",
    sublabel: index === 0 ? "hot key" : "keyspace",
    utilization: cpu / 100,
    meta: { view: "shards", cpu, memory: 3.2 + index * 0.04, hot: index === 0 ? 1 : 0 },
  }));
  const seriesMap: Record<string, number[]> = {};
  nodes.forEach((node, index) => {
    seriesMap[`cpu.${node.id}`] = series(cpus[index], 4, state);
  });
  return {
    t: 42,
    nodes,
    edges: [],
    metrics: baseMetrics(state),
    events: [
      { id: "shard-1", at: 0, severity: "info", title: "Cache healthy", detail: "Eight shards, even distribution." },
      { id: "shard-2", at: 14, severity: state === "crit" ? "crit" : "warn", title: "Hot shard", detail: "shard-0 owns the hot key and is above 85% CPU." },
    ],
    series: seriesMap,
    flags: { state },
    summary: `Eight shards. shard-0 at ${cpus[0].toFixed(0)}% CPU; the others below 25%.`,
  };
}

function queue(state: LabState): SimFrame {
  const health = stateHealth[state];
  const nodes: SimNode[] = [
    { id: "producer", label: "Producer", kind: "service", health: "ok", utilization: 0.5, meta: { view: "flow" } },
    { id: "queue", label: "Orders", kind: "queue", health, utilization: state === "crit" ? 0.95 : 0.35, meta: { view: "flow" } },
    { id: "worker-1", label: "Worker 1", kind: "worker", health: state === "crit" ? "warn" : "ok", utilization: 0.7, meta: { view: "flow" } },
    { id: "worker-2", label: "Worker 2", kind: "worker", health: "ok", utilization: 0.4, meta: { view: "flow" } },
  ];
  return {
    t: 42,
    nodes,
    edges: [edge("p-q", "producer", "queue", 0.8, health), edge("q-w1", "queue", "worker-1", 0.7), edge("q-w2", "queue", "worker-2", 0.4)],
    metrics: baseMetrics(state),
    events: [
      { id: "q-1", at: 0, severity: "info", title: "Queue drained", detail: "Depth near zero at nominal traffic." },
      { id: "q-2", at: 20, severity: "crit", title: "Consumer lag rising", detail: "Production rate exceeds processing rate." },
    ],
    series: { queueDepth: series(40, 20, state), p99: series(90, 30, state) },
    flags: { state },
    summary: "Queue depth is a lag signal; age of the oldest message is the user-facing one.",
  };
}

function replication(state: LabState): SimFrame {
  const nodes: SimNode[] = [
    { id: "primary", label: "Primary", kind: "db", role: "primary", health: "ok", utilization: 0.6, meta: { view: "flow" } },
    { id: "replica-a", label: "Replica A", kind: "db", role: "replica", health: "ok", utilization: 0.3, meta: { view: "flow", lag: 0.04 } },
    { id: "replica-b", label: "Replica B", kind: "db", role: "replica", health: state === "crit" ? "crit" : "warn", utilization: 0.4, meta: { view: "flow", lag: state === "crit" ? 8.2 : 0.4 } },
  ];
  return {
    t: 42,
    nodes,
    edges: [edge("p-a", "primary", "replica-a", 0.6), edge("p-b", "primary", "replica-b", 0.4, state === "crit" ? "crit" : "warn")],
    metrics: baseMetrics(state),
    events: [{ id: "r-1", at: 12, severity: "warn", title: "Replica lag growing", detail: "Replica B is behind the primary by seconds, not milliseconds." }],
    series: { replicaLag: series(0.4, 0.3, state), p99: series(90, 30, state) },
    flags: { state },
    summary: "Read replicas offload reads but lag is a freshness budget.",
  };
}

function deployment(state: LabState): SimFrame {
  const nodes: SimNode[] = [
    { id: "stable-1", label: "stable-1", kind: "instance" as never, health: "ok", meta: { view: "flow", stage: "stable" } },
    { id: "stable-2", label: "stable-2", kind: "service", health: "ok", meta: { view: "flow", stage: "stable" } },
    { id: "canary-1", label: "canary-1", kind: "service", health: stateHealth[state], meta: { view: "flow", stage: "canary" } },
    { id: "full-1", label: "full-1", kind: "service", health: "ok", meta: { view: "flow", stage: "full" } },
  ];
  return {
    t: 42,
    nodes,
    edges: [],
    metrics: baseMetrics(state),
    events: [{ id: "d-1", at: 16, severity: "warn", title: "Canary gate failed", detail: "Error rate is below the limit but capacity at full scale is not proven." }],
    series: { errorPercent: series(1, 0.5, state) },
    flags: { state },
    summary: "A canary at 5% does not prove capacity at 100%.",
  };
}

function topology(state: LabState): SimFrame {
  const nodes: SimNode[] = [
    { id: "vpc-a", label: "VPC A", kind: "service", health: "ok", sublabel: "10.0.0.0/16", meta: { view: "flow" } },
    { id: "tgw", label: "Transit Gateway", kind: "mesh", health: stateHealth[state], sublabel: "hub route table", utilization: 0.4, meta: { view: "flow" } },
    { id: "vpc-b", label: "VPC B", kind: "service", health: state === "crit" ? "crit" : "ok", sublabel: "10.1.0.0/16", meta: { view: "flow" } },
  ];
  return {
    t: 42,
    nodes,
    edges: [edge("a-t", "vpc-a", "tgw", 0.6, state === "crit" ? "crit" : "ok"), edge("t-b", "tgw", "vpc-b", 0.5, state === "crit" ? "crit" : "ok")],
    metrics: baseMetrics(state),
    events: [{ id: "t-1", at: 8, severity: "crit", title: "Route blackhole", detail: "The return path has no matching route." }],
    series: { p99: series(90, 30, state) },
    flags: { state },
    summary: "A route exists but the return path is asymmetric.",
  };
}

function timeline(state: LabState): SimFrame {
  const frame = flow(state);
  frame.events = [
    { id: "tl-1", at: 0, severity: "info", title: "Deploy started", detail: "Canary revision created." },
    { id: "tl-2", at: 12, severity: "warn", title: "Error rate up", detail: "5xx rose from 0.2% to 2.4% on the canary." },
    { id: "tl-3", at: 24, severity: "crit", title: "Full rollout failed", detail: "Capacity saturated at 100% traffic." },
    { id: "tl-4", at: 36, severity: "info", title: "Rollback completed", detail: "Traffic returned to the stable revision." },
  ];
  frame.flags.state = state;
  return frame;
}

export function makeLabFrame(visual: VisualKind, state: LabState): SimFrame {
  switch (visual) {
    case "shards":
    case "heatmap":
      return shards(state);
    case "queue":
      return queue(state);
    case "replication":
      return replication(state);
    case "deployment":
      return deployment(state);
    case "topology":
      return topology(state);
    case "timeline":
      return timeline(state);
    default:
      return flow(state);
  }
}

export type { LabState };
