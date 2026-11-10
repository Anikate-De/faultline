import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_SLOTS = 16_384;
const SLOT_SERVING_NOTE = "The cluster serves the slot from the source or the target; it does not stop the keyspace.";

const params = [
  {
    id: "totalRps",
    label: "Client request rate",
    min: 20_000,
    max: 200_000,
    step: 5_000,
    value: 80_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests arriving at the cluster while the reshard runs. Only requests that touch migrating slots see redirects.",
    format: "rps" as const,
  },
  {
    id: "migratingSlots",
    label: "Slots in migration",
    min: 1,
    max: 1_024,
    step: 1,
    value: 32,
    unit: " slots",
    group: "Migration",
    help: "Slots in the MIGRATING and IMPORTING state at the same time. More slots spread the redirects across a larger slice of the keyspace.",
    format: "count" as const,
  },
  {
    id: "keysPerSlot",
    label: "Keys per migrating slot",
    min: 50,
    max: 5_000,
    step: 50,
    value: 500,
    unit: " keys",
    group: "Migration",
    help: "Average keys moved with each slot. Empty or nearly empty slots finish quickly; large slots take longer and move more values.",
    format: "count" as const,
  },
  {
    id: "migrationRate",
    label: "Migration rate",
    min: 500,
    max: 20_000,
    step: 500,
    value: 5_000,
    unit: " keys/s",
    group: "Migration",
    help: "Keys moved per second across the migrating slots. Higher rates finish sooner but add blocking work to the source shard.",
    format: "rps" as const,
  },
  {
    id: "redirectSupport",
    label: "Redirect-aware clients",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Clients",
    help: "Share of clients that follow MOVED and ASK, refresh their slot map, and retry the request. The rest keep a stale map.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  totalRps: number;
  migratingSlots: number;
  keysPerSlot: number;
  migrationRate: number;
  support: number;
  duration: number;
  progress: number;
  affected: number;
  askRate: number;
  movedRate: number;
  errorRate: number;
  p99: number;
  sourceCpu: number;
  targetCpu: number;
  sourceThroughput: number;
  targetThroughput: number;
  targetEdge: number;
  activeSlots: number;
}

function p99For(cpu: number): number {
  if (cpu >= 100) return 500;
  return Math.min(500, 1.5 + (45 * (cpu / 100) ** 5) / Math.max(0.05, 1.05 - cpu / 100));
}

function compute(p: Params, t: number): Computed {
  const totalRps = Math.max(1, num(p, "totalRps", 80_000));
  const migratingSlots = clamp(Math.round(num(p, "migratingSlots", 32)), 1, 1_024);
  const keysPerSlot = Math.max(50, Math.round(num(p, "keysPerSlot", 500)));
  const migrationRate = Math.max(500, num(p, "migrationRate", 5_000));
  const support = clamp(num(p, "redirectSupport", 100) / 100);
  const duration = Math.max(0.5, (migratingSlots * keysPerSlot) / migrationRate);
  const progress = clamp(t / duration);
  const migratingShare = migratingSlots / TOTAL_SLOTS;
  const affected = totalRps * migratingShare;
  const askRate = progress < 1 ? affected * progress : 0;
  const movedRate = affected * progress * (1 - support * 0.95);
  const errorRate = migratingShare * 100 * (1 - support) * progress;
  const sourceCpu = 20 + migrationRate / 250;
  const targetCpu = 15 + progress * 25 + migratingShare * 100;
  const targetThroughput = affected * progress;
  return {
    totalRps,
    migratingSlots,
    keysPerSlot,
    migrationRate,
    support,
    duration,
    progress,
    affected,
    askRate,
    movedRate,
    errorRate,
    p99: Math.min(500, 1.5 + askRate / 80 + movedRate / 120 + migrationRate / 2_000),
    sourceCpu,
    targetCpu,
    sourceThroughput: totalRps - targetThroughput,
    targetThroughput,
    targetEdge: migratingShare * progress,
    activeSlots: progress < 1 ? migratingSlots : 0,
  };
}

function healthFor(cpu: number): "ok" | "warn" | "crit" {
  if (cpu >= 85) return "crit";
  if (cpu >= 70) return "warn";
  return "ok";
}

function errorHealth(errors: number): "ok" | "warn" | "crit" {
  if (errors >= 2) return "crit";
  if (errors >= 0.5) return "warn";
  return "ok";
}

function formatCpu(cpu: number): string {
  return cpu >= 100 ? "100+%" : `${cpu.toFixed(0)}%`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 8)) / 2.5);
  const seeds: [string, number, number][] = [
    ["request-errors", values.errorRate, 0.05],
    ["redis-p99", values.p99, 2],
    ["ask-redirects", values.askRate, 2],
    ["moved-redirects", values.movedRate, 2],
    ["migration-progress", values.progress * 100, 0.2],
    ["source-cpu", values.sourceCpu, 0.6],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.series["cpu.source"] = Array.from({ length: 24 }, (_, index) =>
    Math.max(0, values.sourceCpu * jitter(index) + Math.sin(index / 2.3) * 0.8),
  );
  frame.series["cpu.target"] = Array.from({ length: 24 }, (_, index) =>
    Math.max(0, values.targetCpu * jitter(index + 2) + Math.sin(index / 2.1) * 0.8),
  );
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, t: number): SimFrame {
  const values = compute(p, t);
  const clientHealth = errorHealth(values.errorRate);
  const sourceHealth = healthFor(values.sourceCpu);
  const targetHealth = healthFor(values.targetCpu);
  const frame: SimFrame = {
    t,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: clientHealth,
        throughput: values.totalRps,
        sublabel: `${Math.round(values.support * 100)}% redirect-aware`,
        detail:
          values.support < 1
            ? "A client that ignores MOVED or ASK keeps its stale slot map and fails on moved keys until it refreshes."
            : "The client follows MOVED, sends ASKING before ASK redirects, and refreshes its slot map.",
        meta: { view: "flow" },
      },
      {
        id: "cluster",
        label: "Cluster slot map",
        kind: "service",
        health: clientHealth,
        utilization: clamp(values.errorRate / 100),
        throughput: values.totalRps,
        sublabel: `${formatCount(values.activeSlots)} slots migrating`,
        detail: `${formatCount(values.migratingSlots)} slots are in migration. ${SLOT_SERVING_NOTE}`,
        meta: { view: "flow" },
      },
      {
        id: "source",
        label: "Source shard",
        kind: "cache",
        role: "shard",
        health: sourceHealth,
        utilization: clamp(values.sourceCpu / 100),
        throughput: values.sourceThroughput,
        sublabel: values.activeSlots > 0 ? "MIGRATING" : "source slot owner",
        detail: `Owns the migrating slots until the final SETSLOT NODE. Replies ASK for a key that has already moved. Source CPU ${formatCpu(values.sourceCpu)}; migration rate ${formatCount(values.migrationRate)} keys/s.`,
        meta: {
          view: "flow",
          cpu: values.sourceCpu,
          p99: p99For(values.sourceCpu),
        },
      },
      {
        id: "target",
        label: "Target shard",
        kind: "cache",
        role: "shard",
        health: targetHealth,
        utilization: clamp(values.targetCpu / 100),
        throughput: values.targetThroughput,
        sublabel: values.activeSlots > 0 ? "IMPORTING" : "target slot owner",
        detail: `Receives keys with MIGRATE. Accepts ASKING followed by the command for imported keys; before the slot is committed, a request without ASKING is redirected with MOVED. Target CPU ${formatCpu(values.targetCpu)}.`,
        meta: {
          view: "flow",
          cpu: values.targetCpu,
          p99: p99For(values.targetCpu),
        },
      },
    ],
    edges: [
      edge("client-cluster", "client", "cluster", values.totalRps / 200_000, clientHealth),
      edge("cluster-source", "cluster", "source", clamp(1 - values.targetEdge), sourceHealth),
      edge("cluster-target", "cluster", "target", clamp(values.targetEdge), targetHealth),
    ],
    metrics: [
      metric("request-errors", "Request errors", values.errorRate, "%", 0.5, 2, "percent"),
      metric("redis-p99", "Redis p99", values.p99, "ms", 40, 120, "ms"),
      metric("ask-redirects", "ASK redirects", values.askRate, "/s", undefined, undefined, "number"),
      metric("moved-redirects", "MOVED redirects", values.movedRate, "/s", undefined, undefined, "number"),
      metric("migration-progress", "Migration progress", values.progress * 100, "%", undefined, undefined, "percent"),
      metric("source-cpu", "Source shard CPU", values.sourceCpu, "%", 70, 85, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${Math.round(values.progress * 100)}% of ${formatCount(values.migratingSlots)} slots migrated; ${values.errorRate.toFixed(1)}% errors; ${formatCount(values.askRate)} ASK/s; ${formatCount(values.movedRate)} MOVED/s.`,
  };
  seedSeries(frame, values, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "request-errors",
    metricId: "request-errors",
    warn: 0.5,
    crit: 2,
    title: "Clients are failing on redirected keys",
    cause:
      "The slot is being served, but the client is not following MOVED or ASK. A stale slot map keeps sending requests to the old owner, or an ASK is treated as a permanent move.",
    fix:
      "Use a redirect-aware client, refresh the slot map on MOVED, and send ASKING before the command on ASK. Roll out the client version before the reshard, or pause the reshard until the clients are ready.",
    checkFirst: [
      "Separate redirect errors from timeouts and cluster-down errors.",
      "Check the client version and whether it follows MOVED and ASK.",
      "Check whether the errors are concentrated on the migrating slots.",
    ],
  },
  {
    id: "redis-p99",
    metricId: "redis-p99",
    warn: 40,
    crit: 120,
    title: "Redirects or migration work are raising p99",
    cause:
      "An ASK path adds a round trip, and MIGRATE moves keys on the source. A high migration rate or a large number of migrating slots can raise latency even for redirect-aware clients.",
    fix:
      "Throttle the migration rate, migrate fewer slots at once, and move large slots during a quieter window. Watch the source shard's event loop and p99, not only the migration progress.",
    checkFirst: [
      "Compare p99 on the source and target with the migration rate.",
      "Check whether the slow requests are the ones that receive ASK.",
      "Check for large keys or a burst of key movement.",
    ],
  },
  {
    id: "source-cpu",
    metricId: "source-cpu",
    warn: 70,
    crit: 85,
    title: "The source shard is saturated by migration work",
    cause:
      "The reshard is moving keys faster than the source can absorb alongside normal traffic. MIGRATE is synchronous work on the source and competes with client commands.",
    fix:
      "Lower the migration rate or spread the slots across more windows. The reshard is online, but online does not mean free.",
    checkFirst: [
      "Check source CPU with and without the migration rate.",
      "Check whether the source is also serving a hot slot.",
      "Check the migration rate and the number of concurrent slots.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const clusterReshardingModel: SimModel = {
  id: "caching-cluster-resharding",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed, 0),
  step: (frame, p, _dt, rng) => {
    const values = compute(p, frame.t);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, seed, frame.t);
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: JSON.stringify(p) };
    const key = JSON.stringify(p);
    if (frame.t <= 0.11 && frame.flags.paramsKey !== key) {
      next.series = {};
      seedSeries(next, values, seed);
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, points]) => [seriesKey, [...points]]),
      );
    }
    const p99Jitter = rng.between(-0.3, 0.3);
    next.metrics = next.metrics.map((item) =>
      item.id === "redis-p99" ? { ...item, value: Math.max(0, item.value + p99Jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    recordSeries(next, "cpu.source", values.sourceCpu);
    recordSeries(next, "cpu.target", values.targetCpu);
    next.events = [...frame.events].slice(-60);
    if (values.errorRate >= 2 && values.support < 1 && frame.flags.redirectFlagged !== 1) {
      pushEvent(next, {
        id: "redirects-ignored",
        at: frame.t,
        severity: "crit",
        title: "Clients are ignoring redirects",
        detail: `${values.errorRate.toFixed(1)}% of requests fail while the cluster still serves the slot. ${Math.round((1 - values.support) * 100)}% of clients have a stale slot map or do not send ASKING after an ASK.`,
        nodeId: "client",
        metricId: "request-errors",
      });
      next.flags.redirectFlagged = 1;
    }
    if (values.errorRate < 0.5) next.flags.redirectFlagged = 0;
    if (values.progress >= 1 && frame.flags.reshardDone !== 1) {
      pushEvent(next, {
        id: "reshard-complete",
        at: frame.t,
        severity: "info",
        title: "Reshard complete",
        detail: `${formatCount(values.migratingSlots)} slots moved at ${formatCount(values.migrationRate)} keys/s. ${
          values.support < 1
            ? "Clients that still ignore redirects will keep failing on the moved slots."
            : "Redirect-aware clients have refreshed their slot maps."
        }`,
        nodeId: "target",
        metricId: "migration-progress",
      });
      next.flags.reshardDone = 1;
    }
    if (values.progress < 1) next.flags.reshardDone = 0;
    next.summary = `${Math.round(values.progress * 100)}% of ${formatCount(values.migratingSlots)} slots migrated; ${values.errorRate.toFixed(1)}% errors; ${formatCount(values.askRate)} ASK/s; ${formatCount(values.movedRate)} MOVED/s.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, frame.t);
    const items: string[] = [];
    items.push(
      `MOVED means the slot has a new owner; the client should refresh its slot map. ASK means the key has already moved but the slot is still migrating; the client sends ASKING to the target and does not update its map.`,
    );
    items.push(
      `${formatCount(values.migratingSlots)} slots are migrating at ${formatCount(values.migrationRate)} keys/s. At ${formatCount(values.keysPerSlot)} keys per slot, the reshard takes about ${values.duration.toFixed(1)}s.`,
    );
    items.push(
      `About ${formatCount(values.affected)} requests/s touch a migrating slot. The current ASK rate is ${formatCount(values.askRate)}/s and the MOVED rate is ${formatCount(values.movedRate)}/s.`,
    );
    items.push(
      `Source CPU is ${formatCpu(values.sourceCpu)} and target CPU is ${formatCpu(values.targetCpu)}. A reshard is online, but it is not free.`,
    );
    if (values.errorRate >= 0.5) {
      items.push(
        `${values.errorRate.toFixed(1)}% of requests fail because ${Math.round((1 - values.support) * 100)}% of clients do not follow redirects. The slot is still served; the client is not.`,
      );
    }
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A small reshard with redirect-aware clients and a modest migration rate.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Large reshard",
    description: "One thousand slots at high traffic. Clients follow redirects, but the ASK rate pushes p99 up.",
    tone: "warn",
    params: defaults({
      totalRps: 200_000,
      migratingSlots: 1_024,
      keysPerSlot: 500,
      migrationRate: 8_000,
      redirectSupport: 100,
    }),
  },
  {
    id: "failure",
    label: "Non-redirecting clients",
    description: "Starts healthy: 512 slots begin moving with no redirect support. Errors rise as keys cross over.",
    tone: "crit",
    params: defaults({
      totalRps: 100_000,
      migratingSlots: 512,
      keysPerSlot: 200,
      migrationRate: 10_000,
      redirectSupport: 0,
    }),
  },
  {
    id: "throttled",
    label: "Throttled",
    description: "The same reshard at a slower rate. Redirects are handled and the source stays below its warning threshold.",
    tone: "info",
    params: defaults({
      totalRps: 100_000,
      migratingSlots: 512,
      keysPerSlot: 200,
      migrationRate: 2_000,
      redirectSupport: 100,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A small slot set, redirect-aware clients, and a controlled rate. The reshard finishes without errors.",
    tone: "ok",
    params: defaults({
      totalRps: 80_000,
      migratingSlots: 64,
      keysPerSlot: 200,
      migrationRate: 10_000,
      redirectSupport: 100,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-redirect-failure",
  title: "Predict who fails during a reshard",
  simId: "cluster-resharding",
  question:
    "A reshard is moving 512 slots. Some clients receive MOVED and others time out. What separates the two groups?",
  prediction: {
    options: [
      { id: "client", label: "The clients that do not follow redirects or refresh their slot map." },
      { id: "source", label: "The clients connected to the source shard, because it is down." },
      { id: "keys", label: "The clients reading large keys, because MIGRATE blocks them." },
      { id: "slot", label: "The clients whose keys are not in a migrating slot." },
    ],
    correctOptionId: "client",
    explanation:
      "The slot is still served during a reshard. A redirect-aware client follows ASK while the slot is migrating and MOVED after the slot commits, then refreshes its slot map. A client that ignores redirects keeps sending to the old owner and fails on the moved keys. Timeouts can also come from migration load on the source, but the split between working and failing clients is explained by redirect handling, not by an unavailable slot.",
  },
  setup: defaults({
    totalRps: 100_000,
    migratingSlots: 512,
    keysPerSlot: 200,
    migrationRate: 10_000,
    redirectSupport: 0,
  }),
  runFor: 20,
  observe: [
    "Request errors cross 2% as the migrating slots move, while the source and target still serve traffic.",
    "ASK and MOVED rates rise; the cluster is redirecting, not down.",
    "The source shard CPU stays near 60%; the failure is client behavior, not a source outage.",
    "p99 rises during the migration and falls after the slots commit, but stays below the critical latency threshold.",
    "After the reshard completes, errors persist because the clients still hold the old slot map.",
  ],
  explain:
    "MOVED and ASK are redirects, not failures. The cluster keeps the slot available by serving it from the source until the key moves and from the target afterward. A client that follows the redirect continues; a client that does not keeps using a stale map. The fix is a redirect-aware client or a client rollout before the reshard, plus a throttled migration rate so the source is not overloaded.",
  fix: defaults({
    totalRps: 80_000,
    migratingSlots: 64,
    keysPerSlot: 200,
    migrationRate: 10_000,
    redirectSupport: 100,
  }),
  debrief:
    "The recovery preset moves a smaller slot set with clients that follow both redirects. Errors fall to zero and p99 stays low. The operational lesson is that a reshard is a client-compatibility operation as much as a cluster operation: checking the client version and the migration rate before the first slot moves is cheaper than discovering the gap in production.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Redis Cluster stores the keyspace in 16,384 hash slots. Each slot is owned by one primary, and a client caches a map from slots to nodes so it can send each command to the right shard. Resharding moves slots from one primary to another. During the move, the source marks the slot MIGRATING and the target marks it IMPORTING. Keys are copied with MIGRATE. The cluster keeps serving the slot throughout: the source serves keys that have not moved, and the target serves keys that have.",
  },
  {
    type: "p",
    text: "Two redirects carry the client through the transition. ASK is a temporary redirect. When a client asks the source for a key that has already moved, the source replies ASK with the target address. The client sends ASKING to the target, then repeats the command. ASK does not change the client's slot map, because the slot is still migrating and the next key may still be on the source. MOVED is a permanent redirect. After the slot is committed to the target, the source replies MOVED and the client updates its slot map. A client that treats ASK as MOVED, or ignores both, will fail or send requests to the wrong node.",
  },
  {
    type: "table",
    headers: ["Redirect", "When it appears", "Client action", "Slot map"],
    rows: [
      ["ASK", "The slot is migrating and the key already moved to the target", "Send ASKING, then the command, to the target", "Do not update; the slot is still in transition"],
      ["MOVED", "The slot has a new owner after the migration commits", "Send the command to the target", "Update the slot map for that slot"],
    ],
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The client sits in front of the slot map. The cluster bus carries topology and failure information between nodes, but command redirects travel on the normal client connection. The source shard does the migration work: it looks up keys in the slot, sends them with MIGRATE, and answers ASK for keys that have already left. The target accepts the imported keys and answers MOVED once it owns the slot. The reshard tooling, such as `redis-cli --cluster reshard`, automates the slot transitions and the key movement.",
  },
  {
    type: "p",
    text: "The cluster remains available for the migrating slot, but the migration is not free. MIGRATE is synchronous work on the source and competes with normal commands. Large values, a high migration rate, or many concurrent slots can raise source CPU and p99. During the migration, multi-key commands that span slots can return TRYAGAIN while keys are in transit; the client should retry with backoff rather than treat it as a permanent error. This module models 1–1,024 migrating slots, a configurable key count and rate, and clients with partial redirect support. The slot count is real; the rates, CPU curve, and key counts are illustrative teaching values.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Migration progress: the share of the selected slots that have reached the target.",
      "ASK and MOVED redirect rates: the two client paths through the move.",
      "Request errors: failures from clients that do not follow redirects, separate from cluster availability.",
      "Redis p99 and source CPU: the cost of moving keys while serving traffic.",
      "A source and target node view: MIGRATING and IMPORTING states, with their CPU.",
      "The target's imported request rate: the traffic that has already crossed over.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Non-redirecting clients. Watch errors rise as progress advances while the source and target keep serving. Compare ASK and MOVED rates, then apply Throttled to see the same slot set at a lower rate. Run the guided experiment before the debrief.",
  },
  {
    type: "p",
    text: "The first question is not how fast the reshard can run. It is whether every client can follow a redirect. A reshard with redirect-aware clients is an online maintenance operation. A reshard with clients that ignore redirects is a client outage with a healthy cluster behind it. Check the client version and the migration rate before the first slot moves.",
  },
  { type: "sim", simId: "cluster-resharding" },
  { type: "experiment", experimentId: "predict-redirect-failure" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The reshard moved slots from the source to the target while the cluster kept serving them. Redirect-aware clients followed ASK for keys that had already moved and MOVED after the slot committed. Clients that ignored both kept sending requests to the old owner and failed on the moved keys. The cluster never lost the slot; the client's cached map was the stale part.",
  },
  {
    type: "p",
    text: "The source paid for the migration with CPU and latency. A higher migration rate finished sooner but competed with normal commands. The throttled preset moved the same slots more slowly and kept the source below its warning threshold. The recovery preset used a smaller slot set, a controlled rate, and clients that follow redirects, so errors fell to zero.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Cluster: `CLUSTER NODES` for slot ownership, `CLUSTER SLOTS` or `CLUSTER SHARDS` for the client-facing map, and `redis-cli --cluster check` before and after the move.",
      "Keys: `CLUSTER COUNTKEYSINSLOT` and `CLUSTER GETKEYSINSLOT` to estimate the work in a slot before moving it.",
      "Redis: `INFO commandstats` for `migrate` and `asking` counts, plus per-node CPU, p99, and connected clients.",
      "Client: MOVED and ASK counts, redirect failures, cross-slot errors, and the client version. A client that does not follow redirects is the first thing to check.",
      "Logs: `MOVED`, `ASK`, `TRYAGAIN`, and timeout messages tied to the migrating slots.",
      "ElastiCache: shard modification events and node-level CPU during an online reshard.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the errors are redirect failures or a real slot outage. If the cluster still serves the slot, the client is not following MOVED or ASK. Then check the client version, the migration rate, and the source shard's CPU before changing the reshard.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the cluster is serving the slot: `CLUSTER NODES` ownership and the source/target health.",
      "Check the client version and whether it follows ASK with ASKING and refreshes on MOVED.",
      "Pause or throttle the reshard if the source is saturated or the client errors are rising.",
      "Move a small slot set first, verify the client behavior end to end, then increase the scope.",
      "Watch ASK/MOVED rates, source CPU, p99, and error rate together; progress alone is not success.",
      "After the move, verify all slots are covered and the old owner has no remaining slots.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A faster reshard finishes sooner but adds blocking work to the source and raises p99.",
      "More concurrent slots spread the redirects but increase the chance of a client bug affecting a larger slice of the keyspace.",
      "ASK adds a round trip per moved key; MOVED is cheaper after the client refreshes its map.",
      "A client rollout is slower than a reshard but is the only way to make redirect failures disappear.",
      "A reshard cannot split a hot slot; it only changes which shard owns the load.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "moved-vs-ask",
    question: "Explain MOVED and ASK to an application engineer.",
    difficulty: 2,
    hints: [
      "One is permanent, one is temporary.",
      "ASK requires ASKING; MOVED updates the slot map.",
    ],
    answer:
      "MOVED means the slot now has a different owner. The client should send the command to the target and update its cached slot map. ASK means the slot is still migrating but this particular key has already moved. The client sends ASKING to the target, then repeats the command. It should not update its slot map for an ASK, because other keys in the slot may still be on the source. Following both redirects keeps the request correct during the reshard.",
    followUps: [
      "Why can't ASK update the slot map?",
      "What happens if a client follows MOVED but not ASK?",
      "How does a client learn about a new node after a failover?",
    ],
    redFlags: [
      "Treats ASK as a permanent move.",
      "Retries the same node after MOVED.",
      "Omits ASKING.",
    ],
    rubric: [
      "Distinguishes permanent from temporary.",
      "Names ASKING.",
      "Explains slot-map update.",
      "Connects to correctness.",
    ],
  },
  {
    id: "split-clients",
    question:
      "During a reshard, some clients work and others time out. How do you explain the split?",
    difficulty: 3,
    hints: [
      "The slot is still served.",
      "Redirect handling is a client property.",
    ],
    answer:
      "I would check whether the working clients are redirect-aware and the failing ones are not. The cluster serves the slot from the source or target, so a client that follows ASK and MOVED should keep working. A client with a stale slot map keeps sending to the old owner and gets redirects it ignores. Timeouts can also come from source CPU or a high migration rate, so I would split the errors by client version and by operation, then compare source p99 with the migration rate.",
    followUps: [
      "What if both groups use the same client version?",
      "How would you distinguish a timeout from a redirect failure?",
      "What would you check before pausing the reshard?",
    ],
    redFlags: [
      "Declares the cluster down without checking slot ownership.",
      "Blames the network for every timeout.",
      "Ignores client versions.",
    ],
    rubric: [
      "Separates redirects from outages.",
      "Uses client version evidence.",
      "Checks source CPU.",
      "States a next action.",
    ],
  },
  {
    id: "plan-reshard",
    question: "How do you plan a reshard that will not break clients?",
    difficulty: 3,
    hints: [
      "Start with client compatibility, not slot count.",
      "Throttle and stage the move.",
    ],
    answer:
      "I would verify that every client version follows MOVED and ASK, test one small slot in staging, and check the client's handling of TRYAGAIN and cross-slot errors. Then I would move a small slot set during a quiet window, watch source CPU, p99, ASK/MOVED rates, and error rate, and increase the scope only if those stay healthy. I would keep a rollback target and avoid moving a hot slot without a plan for its load. The rate and the number of concurrent slots are the two throttles.",
    followUps: [
      "Which metric would make you pause?",
      "How would you roll back a slot?",
      "What would you do about a hot slot?",
    ],
    redFlags: [
      "Starts with all slots at once.",
      "Skips the client compatibility check.",
      "Has no rollback.",
    ],
    rubric: [
      "Checks clients first.",
      "Stages and throttles.",
      "Monitors source and errors.",
      "Plans rollback.",
    ],
  },
  {
    id: "multikey-migration",
    question:
      "A reshard is running and a multi-key command returns TRYAGAIN. What is happening, and what should the client do?",
    difficulty: 3,
    hints: [
      "All keys in a multi-key command must be in the same slot.",
      "Keys in a slot can be split between source and target during migration.",
    ],
    answer:
      "The command's keys are in a slot that is migrating, and some of them are on the source while others are on the target. Redis cannot execute the multi-key operation across the two nodes, so it returns TRYAGAIN. The client should retry with bounded backoff; the slot will finish migrating and the keys will be on one node. The longer-term fix is to keep multi-key operations within one slot using a hash tag, and to avoid changing the tag during the migration. A client that retries forever without a deadline can turn a transient state into an outage.",
    followUps: [
      "How would a hash tag prevent this?",
      "What if the retry never succeeds?",
      "Would you pause the reshard for this client?",
    ],
    redFlags: [
      "Treats TRYAGAIN as a permanent error.",
      "Retries without a bound.",
      "Splits a multi-key command manually without a consistency plan.",
    ],
    rubric: [
      "Explains the split slot.",
      "Bounds the retry.",
      "Names hash tags.",
      "Considers consistency.",
    ],
  },
];

const checklist = [
  {
    title: "Before the reshard",
    items: [
      "Every client version follows MOVED and ASK and refreshes its slot map.",
      "The client handles TRYAGAIN with a bounded retry and backoff.",
      "The slot's key count and large values are known before it moves.",
      "A migration rate and a concurrent-slot limit are set.",
      "A rollback target and a pause procedure are documented.",
    ],
  },
  {
    title: "During the reshard",
    items: [
      "Watch source CPU, p99, ASK/MOVED rates, and request errors together.",
      "Pause or throttle if source CPU or client errors cross the threshold.",
      "Check that the target is importing and the source is migrating.",
      "Do not move a hot slot without a plan for its traffic.",
      "Record the client versions and the slot set in flight.",
    ],
  },
  {
    title: "After the reshard",
    items: [
      "Verify all 16,384 slots are covered and the old owner is empty.",
      "Verify errors return to zero for every client version.",
      "Remove the temporary migration rate limits.",
      "Update the slot map documentation and the next reshard plan.",
    ],
  },
];

const references = [
  {
    title: "Redis cluster specification",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Hash slots, MOVED, ASK, and the migration state machine.",
  },
  {
    title: "Scale with Redis Cluster",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Resharding with redis-cli and client redirect behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cluster-resharding": {
      model: clusterReshardingModel,
      presets,
      instructions:
        "Start healthy, apply Non-redirecting clients, and watch errors rise with migration progress. Compare the ASK and MOVED rates, then apply Throttled and Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["heatmap"],
      note: "Illustrative model. 16,384 slots is real Redis Cluster behavior; migration rates, CPU, and key counts are teaching values, not provider guarantees. Presets start at 0% migration; the failure preset ramps into the error as keys move.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-hot-shard-cluster",
    "caching-key-salting",
    "caching-cluster-failover",
    "caching-hot-key-sharding",
  ],
};
