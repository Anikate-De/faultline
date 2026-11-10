import type { ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { edge, metric, recordSeries } from "@/simulation/engine/frame";

const params: ParamSpec[] = [
  {
    id: "load",
    label: "Request rate",
    min: 100,
    max: 10_000,
    step: 100,
    value: 1_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests arriving at the service. The service is sized for 5,000 rps in this lab model.",
    format: "rps",
  },
  {
    id: "errorRate",
    label: "Injected error rate",
    min: 0,
    max: 20,
    step: 0.5,
    value: 1,
    unit: "%",
    group: "Failure",
    help: "Share of requests that return 5xx before reaching the service.",
    format: "percent",
  },
  {
    id: "latency",
    label: "Dependency latency",
    min: 10,
    max: 500,
    step: 10,
    value: 80,
    unit: "ms",
    group: "Failure",
    help: "Base downstream latency. Queueing multiplies it as utilization rises.",
    format: "ms",
  },
];

const thresholds: ThresholdSpec[] = [
  {
    id: "lab-p99",
    metricId: "p99",
    warn: 300,
    crit: 800,
    title: "p99 latency breached the SLO",
    cause: "Queueing delay grows as service utilization approaches capacity.",
    fix: "Reduce load, add capacity, or shed low-priority work. Then verify p99, not the average.",
    checkFirst: ["Confirm p99 over the same window as the load change.", "Check service utilization and queue depth."],
  },
  {
    id: "lab-errors",
    metricId: "errorPercent",
    warn: 2,
    crit: 5,
    title: "Error rate crossed the threshold",
    cause: "Injected failures are reaching users without a fallback.",
    fix: "Remove the injection, retry only idempotent work with a budget, and confirm the error rate falls before the load.",
    checkFirst: ["Is the error from the service or a dependency?", "Did a release or config change precede it?"],
  },
  {
    id: "lab-util",
    metricId: "utilization",
    warn: 70,
    crit: 90,
    title: "Service saturation",
    cause: "Utilization is in the nonlinear part of the queueing curve.",
    fix: "Add capacity or reduce work before latency becomes self-amplifying.",
    checkFirst: ["Compare p99 with utilization.", "Look for retries or a hot key."],
  },
];

function init(): SimFrame {
  return {
    t: 0,
    nodes: [
      { id: "client", label: "Client", kind: "client", health: "ok", meta: { view: "flow" } },
      { id: "service", label: "Service", kind: "service", health: "ok", utilization: 0.2, throughput: 1_000, meta: { view: "flow" } },
      { id: "dependency", label: "Dependency", kind: "external", health: "ok", utilization: 0.1, meta: { view: "flow" } },
    ],
    edges: [edge("client-service", "client", "service", 0.5), edge("service-dep", "service", "dependency", 0.3)],
    metrics: [
      metric("p99", "p99 latency", 90, "ms", 300, 800, "ms"),
      metric("errorPercent", "Error rate", 1, "%", 2, 5, "percent"),
      metric("utilization", "Service utilization", 20, "%", 70, 90, "percent"),
      metric("throughput", "Throughput", 1_000, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {},
    summary: "Nominal lab model.",
  };
}

function step(frame: SimFrame, p: Params): SimFrame {
  const load = Number(p.load ?? 1_000);
  const error = Number(p.errorRate ?? 1);
  const base = Number(p.latency ?? 80);
  const utilization = Math.min(1.2, load / 5_000);
  const p99 = base * (1 + 4 * utilization ** 3);
  const errorPercent = error;
  const serviceHealth = utilization >= 0.9 || p99 >= 800 ? "crit" : utilization >= 0.7 || p99 >= 300 ? "warn" : "ok";
  frame.nodes = frame.nodes.map((node) => {
    if (node.id === "service") {
      return { ...node, health: serviceHealth, utilization: Math.min(1, utilization), throughput: load };
    }
    if (node.id === "dependency") {
      return { ...node, health: errorPercent >= 5 ? "crit" : errorPercent >= 2 ? "warn" : "ok", utilization: Math.min(1, errorPercent / 20) };
    }
    return node;
  });
  frame.edges = frame.edges.map((item) => ({
    ...item,
    rate: Math.min(1, load / 5_000),
    health: serviceHealth,
  }));
  frame.metrics = [
    metric("p99", "p99 latency", p99, "ms", 300, 800, "ms"),
    metric("errorPercent", "Error rate", errorPercent, "%", 2, 5, "percent"),
    metric("utilization", "Service utilization", Math.min(100, utilization * 100), "%", 70, 90, "percent"),
    metric("throughput", "Throughput", load, " rps", undefined, undefined, "rps"),
  ];
  for (const [key, value] of [
    ["p99", p99],
    ["errorPercent", errorPercent],
    ["utilization", Math.min(100, utilization * 100)],
    ["throughput", load],
  ] as const) {
    recordSeries(frame, key, value);
  }
  frame.summary = `${Math.round(load).toLocaleString()} rps, p99 ${p99.toFixed(0)}ms, errors ${errorPercent}%.`;
  return frame;
}

export const labModel: SimModel = {
  id: "lab-flow",
  visual: "flow",
  params,
  init: () => init(),
  step: (frame, p) => step(frame, p),
  thresholds,
  insights: (frame, p) => [
    `Service utilization is ${(Number(p.load ?? 0) / 5_000 * 100).toFixed(0)}% of the lab's 5k rps capacity.`,
    `p99 is ${(frame.metrics.find((m) => m.id === "p99")?.value ?? 0).toFixed(0)}ms; the SLO warning is 300ms.`,
    "The model is illustrative: queueing rises nonlinearly, but the constants are teaching values.",
  ],
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

export const labPresets: SimPreset[] = [
  { id: "healthy", label: "Healthy", description: "Nominal traffic and a fast dependency.", tone: "ok", params: { load: 1_000, errorRate: 1, latency: 80 } },
  { id: "peak", label: "Peak", description: "High but within capacity.", tone: "warn", params: { load: 3_500, errorRate: 1, latency: 100 } },
  { id: "failure", label: "Failure", description: "Saturation plus errors crosses critical.", tone: "crit", params: { load: 8_000, errorRate: 8, latency: 300 } },
  { id: "recovery", label: "Recovery", description: "Reduce load and remove the failure injection.", tone: "ok", params: { load: 1_500, errorRate: 0.5, latency: 90 } },
];
