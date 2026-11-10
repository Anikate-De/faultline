import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SHARD_COUNT = 6;
const ELECTION_SECONDS = 2;
const SHARD_ERROR_SHARE = 100 / SHARD_COUNT;
const LOST_WRITE_RPS = 2_000;

const params = [
  {
    id: "failedPrimaries",
    label: "Failed primaries",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "Zero is a healthy run. One fails the primary of a single shard; the cluster still owns the other five shards.",
    format: "count" as const,
  },
  {
    id: "nodeTimeout",
    label: "Node timeout",
    min: 3,
    max: 30,
    step: 1,
    value: 15,
    unit: "s",
    group: "Failure",
    help: "Redis calls this cluster-node-timeout: the time a node can be unreachable before it is considered failing.",
    format: "number" as const,
  },
  {
    id: "topologyRefresh",
    label: "Topology refresh interval",
    min: 1,
    max: 300,
    step: 5,
    value: 10,
    unit: "s",
    group: "Clients",
    help: "How often a client refreshes its slot map. A client that refreshes on connection errors recovers sooner than this periodic bound.",
    format: "number" as const,
  },
  {
    id: "retryAttempts",
    label: "Retry attempts",
    min: 0,
    max: 5,
    step: 1,
    value: 2,
    unit: "",
    group: "Clients",
    help: "Retries per failed request. Retries add load and do not fix a stale slot map; writes must be idempotent to retry safely.",
    format: "count" as const,
  },
  {
    id: "partitionSeconds",
    label: "Partition isolation",
    min: 0,
    max: 60,
    step: 5,
    value: 0,
    unit: "s",
    group: "Failure",
    help: "Zero is a crash. A positive value keeps the old primary reachable to some clients for that many seconds, which creates a split-brain write window.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  failed: boolean;
  nodeTimeout: number;
  refresh: number;
  retries: number;
  partition: number;
  failoverAt: number;
  healsBeforePromotion: boolean;
  promoted: boolean;
  promotionCountdown: number;
  staleShare: number;
  errorRate: number;
  p99: number;
  lostWrites: number;
  lossWindow: number;
}

function compute(p: Params, t: number): Computed {
  const failed = num(p, "failedPrimaries", 0) >= 0.5;
  const nodeTimeout = clamp(num(p, "nodeTimeout", 15), 3, 30);
  const refresh = clamp(num(p, "topologyRefresh", 10), 1, 300);
  const retries = clamp(Math.round(num(p, "retryAttempts", 2)), 0, 5);
  const partition = clamp(num(p, "partitionSeconds", 0), 0, 60);
  const failoverAt = nodeTimeout + ELECTION_SECONDS;
  const healsBeforePromotion = partition > 0 && partition < failoverAt;
  const promoted = failed && !healsBeforePromotion && t >= failoverAt;
  let staleShare = 0;
  let errorRate = 0;
  let p99 = 2;
  let lostWrites = 0;
  let lossWindow = 0;
  if (failed) {
    if (healsBeforePromotion) {
      if (t < partition) {
        errorRate = SHARD_ERROR_SHARE;
        p99 = 1_500;
      }
    } else if (t < failoverAt) {
      errorRate = SHARD_ERROR_SHARE;
      p99 = 1_500;
    } else {
      staleShare = Math.max(0, 1 - (t - failoverAt) / refresh) * 100;
      errorRate = (staleShare / 100) * SHARD_ERROR_SHARE;
      p99 = 5 + retries * 2;
      lossWindow = partition > 0 ? Math.min(partition, nodeTimeout) : 0;
      lostWrites = lossWindow > 0 ? LOST_WRITE_RPS * lossWindow : 0;
    }
  }
  return {
    failed,
    nodeTimeout,
    refresh,
    retries,
    partition,
    failoverAt,
    healsBeforePromotion,
    promoted,
    promotionCountdown: failed && !healsBeforePromotion && t < failoverAt ? failoverAt - t : 0,
    staleShare,
    errorRate,
    p99,
    lostWrites,
    lossWindow,
  };
}

function errorHealth(errors: number): "ok" | "warn" | "crit" {
  if (errors >= 5) return "crit";
  if (errors >= 1) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function summarize(values: Computed, t: number): string {
  if (!values.failed) return "No primary failure. The client slot map is current; p99 is 2ms.";
  if (values.healsBeforePromotion) {
    return t < values.partition
      ? `Partition isolating the primary; ${values.errorRate.toFixed(1)}% of requests fail; promotion has not started.`
      : "Partition healed before promotion; the primary rejoined; no failover.";
  }
  if (t < values.failoverAt) {
    return `Primary unreachable; promotion in ${values.promotionCountdown.toFixed(1)}s; ${values.errorRate.toFixed(1)}% of requests fail.`;
  }
  const loss = values.lostWrites > 0 ? `; historical loss: ${formatCount(values.lostWrites)} writes` : "";
  return `Replica promoted after ${values.failoverAt.toFixed(0)}s; ${values.staleShare.toFixed(0)}% of clients still hold a stale topology; p99 ${values.p99.toFixed(0)}ms${loss}.`;
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 6)) / 2.3);
  const seeds: [string, number, number][] = [
    ["error-rate", values.errorRate, 0.2],
    ["redis-p99", values.p99, 2],
    ["stale-clients", values.staleShare, 0.3],
    ["lost-writes", values.lostWrites, Math.max(0.1, values.lostWrites * 0.01)],
    ["promotion-countdown", values.promotionCountdown, 0.1],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
  frame.series["cpu.primary"] = Array.from({ length: 24 }, (_, index) =>
    Math.max(0, (values.failed && !values.promoted ? 0 : 55) * jitter(index) + Math.sin(index / 2.4) * 1.2),
  );
  frame.series["cpu.replica"] = Array.from({ length: 24 }, (_, index) =>
    Math.max(0, (values.failed && !values.promoted ? 0 : 35) * jitter(index + 1) + Math.sin(index / 2.2) * 1.2),
  );
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, t: number): SimFrame {
  const values = compute(p, t);
  const clientHealth = errorHealth(values.errorRate);
  const clusterHealth = clientHealth;
  const primaryDown = values.failed && (values.healsBeforePromotion ? t < values.partition : t < values.failoverAt);
  const primaryHealth = primaryDown ? "down" : "ok";
  const replicaHealth = primaryDown || (values.failed && !values.promoted && !values.healsBeforePromotion) ? "warn" : "ok";
  const phase = !values.failed
    ? "No primary failure"
    : values.healsBeforePromotion
      ? t < values.partition
        ? "Partition isolating the primary"
        : "Partition healed before promotion"
      : t < values.failoverAt
        ? "Primary unreachable, promotion pending"
        : `Replica promoted after ${values.failoverAt.toFixed(0)}s`;
  const frame: SimFrame = {
    t,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: clientHealth,
        sublabel:
          values.staleShare > 0
            ? `${values.staleShare.toFixed(0)}% stale topology`
            : values.errorRate > 0
              ? "connection errors"
              : "topology current",
        detail: `The client caches a slot-to-node map. A stale entry keeps sending requests to the old primary until the map is refreshed. Retries: ${values.retries}.`,
        meta: { view: "flow" },
      },
      {
        id: "cluster",
        label: "Redis Cluster",
        kind: "service",
        health: clusterHealth,
        sublabel: phase,
        detail:
          values.lostWrites > 0
            ? `The cluster owns ${SHARD_COUNT} shards. Historical write loss from this partition: ${formatCount(values.lostWrites)} writes. This does not reflect current availability.`
            : `The cluster owns ${SHARD_COUNT} shards. A single failed primary would affect about ${SHARD_ERROR_SHARE.toFixed(1)}% of keys.`,
        meta: { view: "flow" },
      },
      {
        id: "primary",
        label: values.promoted ? "shard-3 primary (promoted)" : "shard-3 primary",
        kind: "cache",
        role: "primary",
        health: primaryHealth,
        utilization: primaryDown ? 0 : 0.55,
        sublabel: primaryDown
          ? "unreachable"
          : values.promoted
            ? `promoted after ${values.failoverAt.toFixed(0)}s`
            : "in sync",
        detail: primaryDown
          ? `The primary is unreachable. It cannot be promoted; a replica must win an election after cluster-node-timeout (${values.nodeTimeout.toFixed(0)}s) plus election time.`
          : values.promoted
            ? "The former replica now owns the shard's slots. The old primary is replaced; clients must refresh their slot map."
            : "The primary serves the shard's slots and replicates asynchronously to its replica.",
        meta: { view: "flow", lag: 0.02 },
      },
      {
        id: "replica",
        label: values.promoted ? "replacement replica" : "shard-3 replica",
        kind: "cache",
        role: "replica",
        health: replicaHealth,
        utilization: primaryDown ? 0 : 0.35,
        sublabel: values.promoted ? "provisioned" : primaryDown ? "promotion pending" : "in sync",
        detail: values.promoted
          ? "A replacement replica is provisioned after promotion. It syncs from the new primary."
          : primaryDown
            ? "The replica is waiting for failure detection and the election. It cannot serve writes until it is promoted."
            : "The replica follows the primary's replication stream. Its offset is behind by the asynchronous replication window.",
        meta: { view: "flow", lag: primaryDown ? 0 : 0.02 },
      },
    ],
    edges: [
      {
        id: "client-cluster",
        from: "client",
        to: "cluster",
        rate: clientHealth === "ok" ? 0.9 : 0.4,
        health: clientHealth,
      },
      {
        id: "cluster-primary",
        from: "cluster",
        to: "primary",
        rate: primaryDown ? 0.05 : 0.9,
        health: primaryDown ? "down" : "ok",
      },
      {
        id: "primary-replica",
        from: "primary",
        to: "replica",
        rate: primaryDown ? 0.05 : 0.7,
        health: primaryDown ? "warn" : "ok",
      },
    ],
    metrics: [
      metric("error-rate", "Request errors", values.errorRate, "%", 1, 5, "percent"),
      metric("redis-p99", "Redis p99", values.p99, "ms", 200, 500, "ms"),
      metric("stale-clients", "Stale clients", values.staleShare, "%", 10, 30, "percent"),
      metric("lost-writes", "Writes lost", values.lostWrites, " writes", undefined, undefined, "count"),
      metric("promotion-countdown", "Promotion countdown", values.promotionCountdown, "s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: summarize(values, t),
  };
  seedSeries(frame, values, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "Clients are failing on the failed shard",
    cause:
      "Requests to the failed shard cannot be served until a replica is promoted. After promotion, clients that have not refreshed their slot map keep sending requests to the old primary.",
    fix:
      "Refresh the client topology on connection errors and MOVED, and retry with a bounded budget. Do not retry writes unless they are idempotent; an ambiguous write may already have been applied.",
    checkFirst: [
      "Check whether the errors started before or after the promotion.",
      "Check the client's slot-map refresh interval and its handling of MOVED.",
      "Check whether retries are amplifying load on the surviving shards.",
    ],
  },
  {
    id: "redis-p99",
    metricId: "redis-p99",
    warn: 200,
    crit: 500,
    title: "Requests to the failed shard are timing out",
    cause:
      "During the detection window, requests to the failed primary wait for the client timeout. The tail is the timeout, not a slow query on a healthy shard.",
    fix:
      "Keep the client timeout below the request budget, add a bounded retry, and fail fast when the shard is known to be down. A long timeout turns a shard failure into a whole-request outage.",
    checkFirst: [
      "Compare the p99 spike with the promotion time.",
      "Check whether p99 falls after promotion while errors continue; that points to stale topology.",
      "Check the client timeout and retry budget.",
    ],
  },
  {
    id: "stale-clients",
    metricId: "stale-clients",
    warn: 10,
    crit: 30,
    title: "Clients are still using the old topology",
    cause:
      "The replica has been promoted, but a client's cached slot map still points at the old primary. The client receives connection errors and cannot route the request.",
    fix:
      "Refresh the slot map on connection errors and MOVED, shorten the periodic refresh, and roll out the client change. A stale topology is a client bug, not a cluster availability problem.",
    checkFirst: [
      "Check whether the errors are connection errors or MOVED responses.",
      "Check the client's topology refresh interval and version.",
      "Check whether a load balancer or DNS cache is still returning the old endpoint.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const clusterFailoverModel: SimModel = {
  id: "caching-cluster-failover",
  visual: "replication",
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
    const jitter = rng.between(-0.2, 0.2);
    next.metrics = next.metrics.map((item) =>
      item.id === "error-rate" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    recordSeries(next, "cpu.primary", values.failed && frame.t < values.failoverAt ? 0 : 55);
    recordSeries(next, "cpu.replica", values.failed && frame.t < values.failoverAt ? 0 : 35);
    next.events = [...frame.events].slice(-60);
    if (values.failed && frame.flags.primaryDownLogged !== 1) {
      pushEvent(next, {
        id: "primary-unreachable",
        at: frame.t,
        severity: "crit",
        title: "Primary unreachable",
        detail: `One shard's primary is unreachable. The cluster waits for cluster-node-timeout (${values.nodeTimeout.toFixed(0)}s) plus an election in this model before a replica can be promoted.`,
        nodeId: "primary",
        metricId: "error-rate",
      });
      next.flags.primaryDownLogged = 1;
    }
    if (!values.failed) next.flags.primaryDownLogged = 0;
    if (values.promoted && frame.flags.promotedLogged !== 1) {
      pushEvent(next, {
        id: "replica-promoted",
        at: frame.t,
        severity: "info",
        title: "Replica promoted",
        detail: `A replica was promoted after about ${values.failoverAt.toFixed(0)}s. Clients with a stale slot map will keep failing until they refresh; retries do not repair a stale map.`,
        nodeId: "primary",
        metricId: "stale-clients",
      });
      next.flags.promotedLogged = 1;
    }
    if (!values.promoted) next.flags.promotedLogged = 0;
    if (values.lostWrites > 0 && frame.flags.lostLogged !== 1) {
      pushEvent(next, {
        id: "partition-writes-lost",
        at: frame.t,
        severity: "crit",
        title: "Writes lost during the partition",
        detail: `The old primary accepted writes for up to ${values.lossWindow.toFixed(0)}s while isolated. About ${formatCount(values.lostWrites)} writes were not replicated before promotion. This is a historical count, not a live availability signal.`,
        nodeId: "primary",
        metricId: "lost-writes",
      });
      next.flags.lostLogged = 1;
    }
    if (values.lostWrites <= 0) next.flags.lostLogged = 0;
    next.summary = summarize(values, frame.t);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, frame.t);
    const items: string[] = [];
    if (!values.failed) {
      items.push(
        `No primary failure. The model uses a ${values.nodeTimeout.toFixed(0)}s node timeout and a ${values.refresh.toFixed(0)}s topology refresh; neither is exercising a failover.`,
      );
    } else if (values.healsBeforePromotion) {
      items.push(
        frame.t < values.partition
          ? `The primary is isolated by a partition. Promotion has not started; requests to the shard fail until the partition heals or the majority side promotes.`
          : `The partition healed before promotion, so the primary rejoined and no failover occurred. Check for writes accepted during the isolation window.`,
      );
    } else if (frame.t < values.failoverAt) {
      items.push(
        `The primary is unreachable and promotion is ${values.promotionCountdown.toFixed(1)}s away. The outage is detection (${values.nodeTimeout.toFixed(0)}s) plus an illustrative ${ELECTION_SECONDS}s election, not an instant switch.`,
      );
    } else {
      items.push(
        `The replica was promoted after about ${values.failoverAt.toFixed(0)}s. ${values.staleShare.toFixed(0)}% of clients still hold the old slot map, so the cluster is available but those requests fail.`,
      );
    }
    items.push(
      values.failed
        ? `One shard out of ${SHARD_COUNT} is affected, so the outage error share is about ${SHARD_ERROR_SHARE.toFixed(1)}% of all requests. The other shards keep serving.`
        : `The cluster owns ${SHARD_COUNT} shards; a single failed primary would affect about ${SHARD_ERROR_SHARE.toFixed(1)}% of keys.`,
    );
    items.push(
      `Redis replication is asynchronous. A crash can lose writes that were acknowledged but not replicated; a partition can also lose writes accepted by the isolated old primary. WAIT reduces the window but does not make the cluster strongly consistent.`,
    );
    if (values.lostWrites > 0) {
      items.push(
        `The partition isolation is ${values.partition.toFixed(0)}s; the loss window is bounded by the ${values.lossWindow.toFixed(0)}s node timeout. About ${formatCount(values.lostWrites)} writes accepted by the old primary were not replicated before promotion. This count is historical and does not drive live health.`,
      );
    }
    items.push(
      `Retry budget is ${values.retries}. Retries help only after the topology is refreshed; retrying a non-idempotent write can duplicate a side effect.`,
    );
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
    description: "No failure. The primary and replica are in sync, and the client topology is current.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Slow detection",
    description: "A 30s node timeout stretches the write outage to 32s. Clients recover after promotion and refresh.",
    tone: "warn",
    params: defaults({ failedPrimaries: 1, nodeTimeout: 30, topologyRefresh: 10, retryAttempts: 2, partitionSeconds: 0 }),
  },
  {
    id: "failure",
    label: "Stale topology",
    description: "The primary fails and clients refresh only every 300s. The replica is promoted, but errors persist.",
    tone: "crit",
    params: defaults({ failedPrimaries: 1, nodeTimeout: 15, topologyRefresh: 300, retryAttempts: 0, partitionSeconds: 0 }),
  },
  {
    id: "partition",
    label: "Partitioned primary",
    description: "The old primary stays reachable for 30s and accepts writes. The replica is promoted and a historical count of those writes is lost.",
    tone: "crit",
    params: defaults({ failedPrimaries: 1, nodeTimeout: 15, topologyRefresh: 10, retryAttempts: 2, partitionSeconds: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Fast detection, short refresh, and bounded retries. The shard returns to service within the window.",
    tone: "ok",
    params: defaults({ failedPrimaries: 1, nodeTimeout: 5, topologyRefresh: 5, retryAttempts: 2, partitionSeconds: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-failover-gap",
  title: "Predict what recovers last",
  simId: "cluster-failover",
  question:
    "A primary fails and the replica is promoted. If clients refresh their slot map every 300s, what recovers last?",
  prediction: {
    options: [
      { id: "topology", label: "Client routing, because the old slot map keeps sending requests to the failed primary." },
      { id: "cluster", label: "The cluster, because the shard stays unavailable until the client refreshes." },
      { id: "cpu", label: "The replica CPU, because promotion requires a full resync." },
      { id: "p99", label: "Latency, because p99 stays at the timeout after promotion." },
    ],
    correctOptionId: "topology",
    explanation:
      "The cluster promotes a replica after failure detection and election, so the shard is available again before the client knows it. A client with a 300s refresh interval keeps using the old slot map and keeps failing on that shard. Latency can actually fall after promotion because the old address now refuses connections quickly; the errors continue because routing is stale. The client topology is the last thing to recover.",
  },
  setup: defaults({ failedPrimaries: 1, nodeTimeout: 15, topologyRefresh: 300, retryAttempts: 0, partitionSeconds: 0 }),
  runFor: 60,
  observe: [
    "Errors start immediately at about 16.7%, the share of keys owned by the failed shard.",
    "The replica is promoted around 17s; the error rate does not fall because clients still hold the old map.",
    "Stale clients stay near 86% at 60s with a 300s refresh interval.",
    "Redis p99 falls from the 1,500ms timeout to a few milliseconds after promotion, even while errors continue.",
    "The replication view shows the failed primary and its replica; switch to Flow for the client and cluster. The error share stays near 16.7% because only one of six shards is affected.",
  ],
  explain:
    "The cluster's guarantee is about the shard: with a replica and a majority of masters, it can promote a new primary after detection. It does not guarantee that every client knows immediately, and it does not guarantee zero data loss. The client must refresh topology, retry within a budget, and handle the write ambiguity that a failover creates.",
  fix: defaults({ failedPrimaries: 1, nodeTimeout: 5, topologyRefresh: 5, retryAttempts: 2, partitionSeconds: 0 }),
  debrief:
    "The recovery preset shortens detection and refresh, so the error window is bounded. The remaining risk is data: a crash or partition can lose writes that were acknowledged but not replicated. The operational fix is a topology-aware client, idempotent writes, and a tested failover runbook, not a larger timeout.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Redis Cluster divides the keyspace into hash slots owned by primary nodes. Each primary can have one or more replicas that receive its replication stream. If a primary becomes unreachable, the cluster does not switch instantly. Nodes mark it as failing after `cluster-node-timeout`, and a replica can start an election. A majority of the masters that hold slots must vote for the replica, and the replica with the most recent replication offset is the usual winner. The promoted replica takes over the failed primary's slots.",
  },
  {
    type: "p",
    text: "The cluster guarantees availability for the shard only if a replica exists and the majority side can elect it. It does not guarantee zero data loss. Replication is asynchronous: the primary acknowledges a write before every replica has applied it. A crash can lose the writes that had not reached the promoted replica. A network partition is worse in a different way: a client isolated with the old primary can keep writing to it until the node timeout, and those writes are lost if the majority side promotes a replica. Redis exposes `WAIT` to reduce the probability of losing a write, but the cluster is still not strongly consistent.",
  },
  {
    type: "p",
    text: "Clients cache a map from slots to nodes. After a failover, that map is stale. A client that refreshes on connection errors or on MOVED recovers quickly; a client that only refreshes on a long timer keeps sending requests to the old primary. The cluster is healthy and the shard is served, but those requests fail. This is the difference between a cluster availability problem and a client topology problem.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "table",
    headers: ["Phase", "Cluster behavior", "Client behavior", "What to check"],
    rows: [
      ["Primary fails", "Requests to the shard fail; node timeout starts", "Connection errors or timeouts on one shard", "Is the failure a crash or a partition?"],
      ["Detection and election", "PFAIL, then FAIL after a majority agrees; a replica campaigns", "Requests still fail; retries add load", "Node timeout and replica health"],
      ["Replica promoted", "The new primary owns the slots; the old node is replaced", "MOVED or connection error until the map refreshes", "Promotion time and replica offset"],
      ["Client refresh", "The cluster is serving the shard", "New map routes to the promoted primary", "Refresh interval and client version"],
      ["Partition heals", "The old primary rejoins as a replica", "Writes sent to the old primary may be lost", "Lost-write reconciliation"],
    ],
  },
  {
    type: "p",
    text: "The failure detection and election run on the cluster bus, which is a separate port from client traffic. Client commands still use the normal Redis port. The replica election needs a majority of the masters that hold slots; a cluster that has lost that majority cannot promote anyone. ElastiCache Multi-AZ follows the same idea at the managed-service level: it promotes a replica with the least replication lag, typically within seconds, and updates the primary endpoint DNS name. The exact timing is provider behavior, not a Redis guarantee.",
  },
  {
    type: "p",
    text: "This module models one failed shard out of six, with an illustrative two-second election after `cluster-node-timeout`. The six-shard error share, the election time, and the client refresh timer are teaching values. The mechanics are the lesson: detection is not instant, promotion is not instant, and the client's topology is a separate recovery path.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Request errors: the share of keys on the failed shard, then the share still routed by stale clients.",
      "Stale clients: the percentage of clients that have not refreshed their slot map.",
      "Promotion countdown: seconds until the replica is eligible to take over.",
      "Redis p99: the client timeout during the outage, then fast failures after promotion.",
      "Lost writes: a cumulative count of writes accepted by the isolated old primary; historical, not a live availability signal.",
      "A primary and replica view: unreachable, promotion pending, promoted, and replacement states.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Stale topology. Watch the error rate, the promotion countdown, and the p99 drop after promotion while errors continue. Apply Recovery to see a bounded outage. Then try Partitioned primary and compare lost writes with the crash case.",
  },
  {
    type: "p",
    text: "The first question is not how fast the cluster can promote. It is what the client does when the shard moves. A failover exposes two separate contracts: the cluster keeps the shard available if a replica and a majority exist, and the client must refresh its topology and retry safely. A runbook that tests only the first contract will still page on the second.",
  },
  { type: "sim", simId: "cluster-failover" },
  { type: "experiment", experimentId: "predict-failover-gap" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "One primary became unreachable, so every request for its slots failed. The cluster waited for the node timeout, held an election, and promoted the replica. After promotion the shard was available again, but clients with a stale slot map kept sending requests to the old primary. The error rate stayed high while p99 fell, because the old address now failed fast. The last thing to recover was the client's topology.",
  },
  {
    type: "p",
    text: "The partition preset showed a different failure: the old primary stayed reachable long enough to accept writes that the promoted replica never received. Those writes were lost. A crash can also lose the last writes because replication is asynchronous, but the partition makes the window explicit and gives the old primary a chance to accept them. Neither case is a reason to skip the failover; both are reasons to make writes idempotent and to reconcile after recovery.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ElastiCache: failover events, node-level `EngineCPUUtilization`, `CurrConnections`, `ReplicationLag`, and the primary endpoint. Multi-AZ promotes the replica with the least lag and updates the endpoint.",
      "Redis: `INFO replication` and `ROLE` for offsets and link state, and `CLUSTER NODES` for the new slot owner.",
      "Clients: connection errors, MOVED responses, topology refresh counts, retry counts, and the client version. Split the error rate by shard and by client version.",
      "Latency: p99 before and after promotion. A drop in p99 with a flat error rate points to stale topology, not a slow cluster.",
      "Writes: the last replication offset on the old primary and the promoted replica, plus any reconciliation or idempotency-key records.",
      "Logs: connection refused, timeout, MOVED loops, and retry bursts from one client pool.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the cluster has promoted a replica and whether the client has refreshed its slot map. If the shard is served and the client still fails, this is a topology problem. If the failure was a partition, check the write offsets before declaring recovery.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the failure mode: crash, partition, or a single node restart. They have different write-loss behavior.",
      "Confirm the cluster has a replica and a majority of slot-owning masters; without them, no promotion is possible.",
      "Keep the client timeout below the request budget and retry with a bounded, jittered budget.",
      "Refresh topology on connection errors and MOVED; do not rely only on a long periodic refresh.",
      "Make writes idempotent, and reconcile the old primary's last offset if a partition accepted writes.",
      "Test a failover in staging and verify the client error window, promotion time, and write reconciliation.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A shorter node timeout detects failure sooner but increases false positives under transient network jitter.",
      "A longer timeout reduces false failovers but lengthens the write outage; the right value depends on the network and the SLO.",
      "Aggressive retries shorten some client errors but amplify load during the outage and can duplicate non-idempotent writes.",
      "Synchronous replication or `WAIT` reduces the write-loss window at a latency cost; it still does not provide strong consistency.",
      "A fast client refresh recovers routing sooner but adds topology traffic and can create a refresh storm after a failover.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "what-guarantee",
    question: "What does Redis Cluster guarantee when a primary fails over?",
    difficulty: 3,
    hints: [
      "Separate shard availability from data durability.",
      "Replication is asynchronous.",
    ],
    answer:
      "It can keep the shard available if the failed primary has a replica and a majority of the slot-owning masters can agree on the failure and elect the replica. The promoted replica takes over the slots, and clients that refresh their topology continue. It does not guarantee zero data loss: replication is asynchronous, so a crash can lose writes that were acknowledged but not replicated. A partition can also lose writes accepted by the isolated old primary. The cluster is available, not strongly consistent.",
    followUps: [
      "What happens if the majority is lost?",
      "How does `WAIT` change the guarantee?",
      "What does the client need to do after promotion?",
    ],
    redFlags: [
      "Claims zero data loss.",
      "Ignores the majority requirement.",
      "Assumes clients switch automatically.",
    ],
    rubric: [
      "Names replica plus majority.",
      "Separates availability from durability.",
      "Explains asynchronous loss.",
      "Mentions client refresh.",
    ],
  },
  {
    id: "timeline",
    question:
      "A primary fails and clients see about 15% errors for 20 seconds, then errors continue at a lower rate. Walk through the timeline.",
    difficulty: 3,
    hints: [
      "One shard out of six is about 16.7% of keys.",
      "Promotion and client refresh are different events.",
    ],
    answer:
      "The first errors are the failed shard: one of six shards is roughly 16.7% of the keys, so requests to those slots fail while the other five serve. The cluster waits for cluster-node-timeout and then holds an election; after promotion the shard is available. If errors continue at a lower rate, some clients still have the old slot map and keep sending to the old primary. They recover when they refresh on a connection error, MOVED, or their periodic timer. p99 may fall after promotion because the old address fails fast while the errors persist.",
    followUps: [
      "How would you confirm the second phase is stale topology?",
      "What if the errors are not limited to one shard?",
      "What would you check before increasing the node timeout?",
    ],
    redFlags: [
      "Blames the whole cluster for one shard.",
      "Treats promotion and client recovery as the same event.",
      "Increases the timeout without a hypothesis.",
    ],
    rubric: [
      "Computes the shard share.",
      "Separates detection, promotion, and refresh.",
      "Uses p99 and errors together.",
      "Names a confirmation step.",
    ],
  },
  {
    id: "crash-vs-partition",
    question:
      "Which is worse for writes, a primary crash or a network partition, and why?",
    difficulty: 3,
    hints: [
      "A crash stops accepting writes.",
      "A partition can leave the old primary writable.",
    ],
    answer:
      "A crash stops the old primary, so the loss window is the asynchronous replication lag: writes that were acknowledged but not yet applied by the replica. A partition can be worse because the old primary may stay reachable to some clients and keep accepting writes until the node timeout. If the majority side promotes a replica, those writes are not in the new primary and are lost when the partition heals. The maximum window is bounded by the node timeout, but the old primary can still acknowledge writes during it. Idempotency and reconciliation matter in both cases.",
    followUps: [
      "How does the node timeout bound the partition window?",
      "What would you do with the old primary after it rejoins?",
      "Can `WAIT` eliminate the partition loss?",
    ],
    redFlags: [
      "Says a partition is always safe because the majority wins.",
      "Ignores writes accepted by the old primary.",
      "Claims `WAIT` gives strong consistency.",
    ],
    rubric: [
      "Separates crash and partition.",
      "Explains the replication window.",
      "Bounds the partition by node timeout.",
      "Names reconciliation.",
    ],
  },
  {
    id: "retry-design",
    question:
      "How do you design client retries and topology refresh for a Redis Cluster failover?",
    difficulty: 3,
    hints: [
      "Retries do not fix a stale map.",
      "Writes need idempotency.",
    ],
    answer:
      "I would refresh topology on connection errors and MOVED, not only on a timer, and I would keep a short periodic refresh as a backstop. Retries would be bounded with exponential backoff and jitter, and the total retry budget would fit inside the request deadline. Reads can retry freely if they are safe; writes need an idempotency key or a reconciliation path because the first attempt may have been applied. I would test the client against a forced failover and measure the error window, the refresh time, and the retry amplification before trusting the policy.",
    followUps: [
      "What is the risk of retrying every write?",
      "How would you avoid a refresh storm after failover?",
      "Which metric tells you the client has recovered?",
    ],
    redFlags: [
      "Retries forever without a budget.",
      "Retries writes without idempotency.",
      "Only uses a long periodic refresh.",
    ],
    rubric: [
      "Refreshes on errors and MOVED.",
      "Bounds retries with jitter.",
      "Handles write ambiguity.",
      "Tests the failover.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every shard has a replica, and a majority of slot-owning masters can be reached.",
      "Clients refresh topology on connection errors and MOVED, with a short periodic backstop.",
      "Retries are bounded with jitter and fit inside the request deadline.",
      "Writes that must not be duplicated have an idempotency or reconciliation path.",
      "A failover test covers promotion time, client errors, and write loss.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Classify the failure: crash, partition, or a single node restart.",
      "Confirm the shard has a promoted primary before blaming the cluster.",
      "Check whether client errors are connection errors or stale routing.",
      "Do not raise the node timeout without a network-jitter hypothesis.",
      "Record the last replication offsets if a partition accepted writes.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the promoted primary owns all of the shard's slots.",
      "Verify every client version has refreshed and errors are zero.",
      "Reconcile writes from the old primary if a partition occurred.",
      "Replace failed nodes and confirm replicas are in sync.",
      "Update the failover runbook with the observed timeline.",
    ],
  },
];

const references = [
  {
    title: "Redis cluster specification",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Failure detection, failover elections, and consistency guarantees.",
  },
  {
    title: "Minimizing downtime with Multi-AZ",
    url: "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/AutoFailover.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "ElastiCache replica promotion, endpoint updates, and failover behavior.",
  },
  {
    title: "Redis replication",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/replication/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Asynchronous replication, WAIT, and the write-loss window.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cluster-failover": {
      model: clusterFailoverModel,
      presets,
      instructions:
        "Start healthy, apply Stale topology, and watch the promotion countdown. Compare p99 with the error rate after promotion, then apply Recovery and Partitioned primary.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow", "heatmap"],
      note: "Illustrative model. One failed shard out of six, a two-second election after cluster-node-timeout, and a periodic client refresh. Lost writes use an illustrative 2,000 writes/s for the isolated shard and are a cumulative count, not a live health signal. Election time and client behavior are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-read-replicas",
    "caching-cluster-resharding",
    "caching-hot-shard-cluster",
    "caching-hot-key-sharding",
  ],
};
