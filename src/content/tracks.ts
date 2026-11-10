import {
  Activity,
  AlertTriangle,
  Boxes,
  Cloud,
  Database,
  FileWarning,
  GitBranch,
  Globe2,
  Gauge,
  Layers,
  Lock,
  Network,
  Radio,
  Server,
  ShieldCheck,
  Timer,
  Workflow,
} from "lucide-react";
import type { TrackDef, TrackId } from "./types";

export const TRACKS: TrackDef[] = [
  {
    id: "foundations",
    title: "Foundations",
    short: "Foundations",
    purpose: "Mental models, queueing, Linux, HTTP, resilience, security basics",
    description:
      "The models that make incidents legible: utilization and queues, percentiles, budgets, timeouts, retries, saturation, and the limits of a single host.",
    planned: 32,
  },
  {
    id: "observability",
    title: "Observability",
    short: "Observability",
    purpose: "Datadog, Grafana, VictoriaMetrics, OTel, SLOs, alerting",
    description:
      "Turn telemetry into a decision. Cardinality, PromQL, traces, logs, sampling, burn-rate alerts, and dashboards that answer one question.",
    planned: 34,
  },
  {
    id: "traffic",
    title: "Traffic & Edge",
    short: "Traffic",
    purpose: "DNS, ALB/NLB, CDN, WAF, rate limits, connection management",
    description:
      "Where requests enter and where they die: load balancer layers, limits, health checks, DNS failover, CDN behavior, and edge protection.",
    planned: 34,
  },
  {
    id: "caching",
    title: "Caching",
    short: "Caching",
    purpose: "Redis, hot keys, stampede, local cache, coherence",
    description:
      "Caches fail in shapes that aggregate metrics hide. Find the hot shard, stop the stampede, and choose the fix whose tradeoff you can live with.",
    planned: 28,
  },
  {
    id: "databases",
    title: "Relational Data",
    short: "Databases",
    purpose: "RDS/Aurora, replication, failover, backups, DR",
    description:
      "Primary and replica behavior, connection pools, lag, failover, split brain, backups, and the difference between a database and an application recovery.",
    planned: 32,
  },
  {
    id: "mongodb",
    title: "Document Data",
    short: "MongoDB",
    purpose: "Replica sets, sharding, read preference, write concern",
    description:
      "Replica sets and sharded clusters, read preferences, write concerns, elections, chunk migration, and why adding a reader can make an incident worse.",
    planned: 22,
  },
  {
    id: "streaming",
    title: "Streaming & Messaging",
    short: "Streaming",
    purpose: "Kafka, Confluent, WarpStream, MQTT, SQS/SNS",
    description:
      "Partitions, keys, consumer groups, lag, retries, DLQs, exactly-once boundaries, object-storage streaming, and protocol-level delivery semantics.",
    planned: 32,
  },
  {
    id: "containers",
    title: "Containers & ECS",
    short: "Containers",
    purpose: "ECS/Fargate, autoscaling, task lifecycle, deployments",
    description:
      "Tasks, services, placement, scaling races, draining, cold starts, OOM kills, IAM roles, and the operational edges of managed containers.",
    planned: 26,
  },
  {
    id: "mesh",
    title: "Service Mesh",
    short: "Mesh",
    purpose: "Envoy, Kuma, mTLS, retries, circuit breaking, locality",
    description:
      "The proxy is part of the failure domain. Listeners, routes, retries, outlier detection, mTLS, and locality-aware failover.",
    planned: 22,
  },
  {
    id: "deployment",
    title: "Release Engineering",
    short: "Deployment",
    purpose: "Canary, blue-green, flags, migrations, rollback",
    description:
      "Ship without guessing: canaries and gates, rollout capacity, database compatibility, automated rollback, and the data a rollback cannot undo.",
    planned: 28,
  },
  {
    id: "reliability",
    title: "Reliability & Incidents",
    short: "Reliability",
    purpose: "Incident command, postmortems, chaos, load shedding",
    description:
      "Run the incident, not just the debugger. Roles, cadence, severity, degradation, failover decisions, postmortems, and actions that land.",
    planned: 32,
  },
  {
    id: "cloud-networking",
    title: "Cloud Networking",
    short: "Cloud Networking",
    purpose: "VPC, peering, TGW, route tables, PrivateLink, IAM",
    description:
      "Follow the packet: VPC boundaries, route tables, NAT, peering and transit gateways, private endpoints, hybrid links, and IAM trust.",
    planned: 32,
  },
  {
    id: "compliance",
    title: "Compliance & GRC",
    short: "Compliance",
    purpose: "HIPAA, GDPR, SOC 2, audit, data residency",
    description:
      "Turn obligations into controls and evidence: PHI, data-subject rights, residency, access review, retention, vendor chains, and policy as code.",
    planned: 20,
  },
  {
    id: "capacity",
    title: "Capacity & Cost",
    short: "Capacity",
    purpose: "Autoscaling, scaling races, unit economics",
    description:
      "Capacity is a budget and a queue. Size headroom, model unit cost, avoid scaling races, and keep observability affordable.",
    planned: 22,
  },
  {
    id: "case-files",
    title: "Case Files",
    short: "Case Files",
    purpose: "Real incidents and clearly labeled composites",
    description:
      "Replay public incidents and original composite scenarios: timeline, telemetry, decision points, and the fix under pressure.",
    planned: 60,
  },
  {
    id: "kubernetes",
    title: "Kubernetes",
    short: "Kubernetes",
    purpose: "Reserved for a later build",
    description:
      "This track is intentionally empty. You will learn Kubernetes from a clean baseline, not as a bolt-on to this build.",
    planned: 0,
    reserved: true,
  },
];

export const TRACK_BY_ID = new Map(TRACKS.map((t) => [t.id, t]));

export const TRACK_ICONS: Record<TrackId, typeof Activity> = {
  foundations: Activity,
  observability: Gauge,
  traffic: Globe2,
  caching: Timer,
  databases: Database,
  mongodb: Layers,
  streaming: Radio,
  containers: Boxes,
  mesh: Network,
  deployment: GitBranch,
  reliability: AlertTriangle,
  "cloud-networking": Cloud,
  compliance: ShieldCheck,
  capacity: Gauge,
  "case-files": FileWarning,
  kubernetes: Server,
};

export const PATHWAY = [
  { id: "beginner", title: "Start here", note: "New to reliability", tracks: ["foundations", "observability", "traffic", "caching"] },
  { id: "incident", title: "Incident response", note: "On-call and diagnosis", tracks: ["foundations", "observability", "caching", "databases", "reliability"] },
  { id: "aws", title: "AWS platform", note: "Build and operate", tracks: ["traffic", "containers", "databases", "cloud-networking", "capacity"] },
] satisfies { id: string; title: string; note: string; tracks: TrackId[] }[];

export const NAV_ICONS = { Lock, Workflow };
