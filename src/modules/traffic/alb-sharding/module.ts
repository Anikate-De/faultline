import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SHARD_RPS_CAPACITY = 30_000;
const AFFINITY_SPLIT_LOSS = 8;

const params = [
  {
    id: "requestRate",
    label: "Total request rate",
    min: 5_000,
    max: 80_000,
    step: 1_000,
    value: 20_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second across all tenants. Sharding changes how this total is split, not how much of it arrives.",
    format: "rps" as const,
  },
  {
    id: "tenantCount",
    label: "Tenants",
    min: 2,
    max: 40,
    step: 1,
    value: 12,
    unit: "",
    group: "Traffic",
    help: "Number of tenants sharing the ALB fleet. Each tenant is mapped to a shard by the selected key.",
    format: "count" as const,
  },
  {
    id: "hotTenantShare",
    label: "Largest tenant share",
    min: 5,
    max: 80,
    step: 5,
    value: 20,
    unit: "%",
    group: "Traffic",
    help: "Share of all requests that come from the single largest tenant. A hot tenant is one routing key, not many.",
    format: "percent" as const,
  },
  {
    id: "shardCount",
    label: "ALB shards",
    min: 1,
    max: 6,
    step: 1,
    value: 3,
    unit: "",
    group: "Topology",
    help: "Number of ALBs in the shard fleet. Each shard has its own DNS name, target group, and illustrative 30,000 rps capacity.",
    format: "count" as const,
  },
  {
    id: "shardKey",
    label: "Shard key",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Routing",
    help: "0 hostname modulo, 1 tenant hash, 2 path split for the hot tenant, 3 dedicated hot-tenant shard. Path split reduces load but can break sessions.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Demand {
  requestRate: number;
  tenantCount: number;
  hotShare: number;
  shardCount: number;
  shardKey: number;
  loads: number[];
  hotShardIndex: number;
  hotShardLoad: number;
  averageLoad: number;
  hotUtilization: number;
  imbalance: number;
  errorRate: number;
  affinityLoss: number;
  effectiveShards: number;
  hotTenantLoad: number;
}

function demand(p: Params): Demand {
  const requestRate = Math.max(1, num(p, "requestRate", 20_000));
  const tenantCount = Math.max(2, Math.round(num(p, "tenantCount", 12)));
  const hotShare = clamp(num(p, "hotTenantShare", 20) / 100, 0.02, 0.95);
  const shardCount = Math.max(1, Math.round(num(p, "shardCount", 3)));
  const shardKey = Math.round(clamp(num(p, "shardKey", 0), 0, 3));
  const loads = Array.from({ length: shardCount }, () => 0);
  const hotTenantLoad = requestRate * hotShare;
  const otherEach = (requestRate - hotTenantLoad) / Math.max(1, tenantCount - 1);

  if (shardKey === 2) {
    for (let index = 0; index < shardCount; index++) loads[index] += hotTenantLoad / shardCount;
  } else if (shardKey === 3) {
    loads[0] += hotTenantLoad;
  } else {
    const hotIndex = shardKey === 1 ? (3 % shardCount) : 0;
    loads[hotIndex] += hotTenantLoad;
  }

  for (let tenant = 1; tenant < tenantCount; tenant++) {
    let shard: number;
    if (shardKey === 1) {
      shard = (tenant * 7 + 3) % shardCount;
    } else if (shardKey === 3 && shardCount > 1) {
      shard = 1 + ((tenant - 1) % (shardCount - 1));
    } else {
      shard = tenant % shardCount;
    }
    loads[shard] += otherEach;
  }

  let hotShardIndex = 0;
  for (let index = 1; index < loads.length; index++) {
    if (loads[index] > loads[hotShardIndex]) hotShardIndex = index;
  }
  const hotShardLoad = loads[hotShardIndex];
  const averageLoad = requestRate / shardCount;
  const hotUtilization = (hotShardLoad / SHARD_RPS_CAPACITY) * 100;
  const imbalance = hotShardLoad / Math.max(1, averageLoad);
  const errorRate = Math.min(100, Math.max(0, hotUtilization - 100) * 0.9);
  const affinityLoss = shardKey === 2 && shardCount > 1 ? AFFINITY_SPLIT_LOSS : 0;
  const effectiveShards =
    requestRate ** 2 / Math.max(1, loads.reduce((sum, load) => sum + load ** 2, 0));

  return {
    requestRate,
    tenantCount,
    hotShare,
    shardCount,
    shardKey,
    loads,
    hotShardIndex,
    hotShardLoad,
    averageLoad,
    hotUtilization,
    imbalance,
    errorRate,
    affinityLoss,
    effectiveShards,
    hotTenantLoad,
  };
}

function shardKeyLabel(value: number): string {
  if (value === 1) return "tenant hash";
  if (value === 2) return "path split";
  if (value === 3) return "dedicated hot shard";
  return "hostname modulo";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = demand(p);
  const shardNodes = d.loads.map((load, index) => {
    const utilization = (load / SHARD_RPS_CAPACITY) * 100;
    return {
      id: `shard-${index}`,
      label: `ALB shard ${index + 1}`,
      kind: "lb" as const,
      role: "shard" as const,
      health: healthFor(utilization, 80, 95),
      utilization: clamp(utilization / 100),
      throughput: load,
      capacity: SHARD_RPS_CAPACITY,
      sublabel: `${formatCount(load)} rps · ${((load / d.requestRate) * 100).toFixed(0)}% of traffic`,
      detail: `Shard ${index + 1} carries ${formatCount(load)} rps on the ${shardKeyLabel(d.shardKey)} key. Illustrative capacity is ${formatCount(SHARD_RPS_CAPACITY)} rps. ${index === d.hotShardIndex ? "This is the hottest shard; the fleet average hides it." : ""}`,
      meta: {
        view: "shards",
        cpu: utilization,
        memory: 2 + utilization / 50,
        hot: utilization >= 80 ? 1 : 0,
      },
    };
  });
  return {
    t: 0,
    nodes: [
      {
        id: "ingress",
        label: "Shard front door",
        kind: "dns" as const,
        health: "ok" as const,
        utilization: 0.5,
        throughput: d.requestRate,
        sublabel: `${shardKeyLabel(d.shardKey)} · ${d.shardCount} shard${d.shardCount === 1 ? "" : "s"}`,
        detail: "The front door maps each request to one ALB shard. A hostname or tenant key cannot be split by adding shards.",
        meta: { view: "flow" },
      },
      ...shardNodes,
    ],
    edges: d.loads.map((load, index) =>
      edge(`ingress-shard-${index}`, "ingress", `shard-${index}`, load / Math.max(1, d.requestRate), healthFor((load / SHARD_RPS_CAPACITY) * 100, 80, 95)),
    ),
    metrics: [
      metric("hot-shard-utilization", "Hottest shard utilization", d.hotUtilization, "%", 80, 95, "percent"),
      metric("imbalance", "Hottest shard vs average", d.imbalance, "×", 1.5, 2.0, "number"),
      metric("error-rate", "Failed requests", d.errorRate, "%", 0.5, 2, "percent"),
      metric("affinity-loss", "Sessions crossing shards", d.affinityLoss, "%", 10, 25, "percent"),
      metric("effective-shards", "Effective shards", d.effectiveShards, "", undefined, undefined, "count"),
      metric("hot-shard-load", "Hottest shard load", d.hotShardLoad, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, shardKey: d.shardKey, shards: d.shardCount, paramsKey: "" },
    summary: `${d.shardCount} shard${d.shardCount === 1 ? "" : "s"} on ${shardKeyLabel(d.shardKey)}; hottest at ${d.hotUtilization.toFixed(0)}% (${formatCount(d.hotShardLoad)} rps); ${d.errorRate.toFixed(1)}% failed requests; ${d.affinityLoss.toFixed(0)}% sessions cross shards.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = Math.abs(item.value) * 0.015 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(
        0,
        item.value * (0.985 + 0.03 * Math.sin((index + (seed % 5)) / 2.6)) +
          Math.sin(index / 2.2) * amplitude,
      ),
    );
  }
  for (const node of frame.nodes) {
    if (node.meta?.cpu === undefined) continue;
    const cpu = Number(node.meta?.cpu ?? 0);
    frame.series[`cpu.${node.id}`] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, cpu * (0.98 + 0.04 * Math.sin((index + (seed % 4)) / 2.2))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "hot-shard-utilization",
    metricId: "hot-shard-utilization",
    warn: 80,
    crit: 95,
    title: "One ALB shard is saturated while the fleet has capacity",
    cause:
      "The shard key maps a heavy tenant to one shard. Adding shards does not split a single hostname or tenant, so the hot shard keeps its load while the new shards stay idle. The fleet average hides the imbalance.",
    fix:
      "Isolate the tenant on a dedicated shard if it fits, split its traffic by path or connection if sessions allow, or move other tenants off the hot shard. Only then add shards, and verify the hottest shard rather than the average.",
    checkFirst: [
      "Compare RequestCount per ALB, not only the fleet total.",
      "Identify the tenants or hostnames mapped to the hottest shard.",
      "Check whether the shard key is hostname, path, tenant, or a hash; a single key cannot be split by adding shards.",
    ],
  },
  {
    id: "imbalance",
    metricId: "imbalance",
    warn: 1.5,
    crit: 2.0,
    title: "The shard map is concentrating traffic",
    cause:
      "The hottest shard carries more than twice the average. A hot tenant, a hash collision, or a modulo mapping that sends several heavy tenants to the same shard can produce this even when total capacity is sufficient.",
    fix:
      "Rebalance the mapping, isolate the heavy tenant, or use a key with more even distribution. Recheck after adding shards; a new shard only helps if the mapping actually moves traffic onto it.",
    checkFirst: [
      "List per-shard request counts and the top tenants on each shard.",
      "Check whether the hot tenant is a single routing key.",
      "Check the hash or modulo function for collisions and recent tenant additions.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 0.5,
    crit: 2,
    title: "The hot shard is returning errors",
    cause:
      "The hottest shard is above its illustrative request capacity, so requests queue and fail while other shards have headroom. The failure is local to one shard, not the whole fleet.",
    fix:
      "Move load off the hot shard first. If the tenant cannot be split, give it a dedicated shard sized for its peak, or move other tenants away. Adding an empty shard without a routing change does nothing.",
    checkFirst: [
      "Check HTTPCode_ELB_5XX_Count per ALB and per target group.",
      "Confirm the errors are on the hot shard, not spread across the fleet.",
      "Check the hot shard's target health before adding capacity.",
    ],
  },
  {
    id: "affinity-loss",
    metricId: "affinity-loss",
    warn: 10,
    crit: 25,
    title: "Splitting a tenant is breaking session affinity",
    cause:
      "Path splitting or connection-level distribution sends a session to more than one shard. If session state is local to a target, requests arrive where the state is not, so carts or logins fail even though the load is now balanced.",
    fix:
      "Move session state to a shared store, keep hostname affinity for the session-bearing paths, or accept the split only for stateless paths. Measure session misses, not just request success.",
    checkFirst: [
      "Check session miss or re-login rates after the routing change.",
      "Check whether session state is local to a target or in a shared store.",
      "Check whether sticky sessions are enabled on more than one target group or layer.",
    ],
  },
];

export const albShardingModel: SimModel = {
  id: "alb-sharding",
  visual: "shards",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const d = demand(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, seed);
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: key };
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, seed);
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    const noise = rng.between(-0.003, 0.003);
    next.metrics = next.metrics.map((item) =>
      item.id === "hot-shard-load"
        ? { ...item, value: Math.max(0, item.value * (1 + noise)) }
        : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    for (const node of next.nodes) {
      if (node.meta?.cpu === undefined) continue;
      recordSeries(next, `cpu.${node.id}`, Number(node.meta?.cpu ?? 0));
    }

    if (d.shardKey !== Number(frame.flags.shardKey ?? 0)) {
      pushEvent(next, {
        id: "shard-key-change",
        at: frame.t,
        severity: "info",
        title: `Shard key changed to ${shardKeyLabel(d.shardKey)}`,
        detail: `The hottest shard is now shard ${d.hotShardIndex + 1} at ${d.hotUtilization.toFixed(0)}% utilization. ${d.affinityLoss > 0 ? "Path splitting can send one session to more than one shard." : "Hostname and tenant keys keep each session on one shard."}`,
        nodeId: `shard-${d.hotShardIndex}`,
        metricId: "hot-shard-utilization",
      });
    }
    if (d.shardCount !== Number(frame.flags.shards ?? 1)) {
      pushEvent(next, {
        id: "shard-count-change",
        at: frame.t,
        severity: "info",
        title: `ALB fleet changed to ${d.shardCount} shard${d.shardCount === 1 ? "" : "s"}`,
        detail: `The hottest shard is at ${d.hotUtilization.toFixed(0)}%. Adding a shard only helps if the shard key moves traffic onto it.`,
        nodeId: `shard-${d.hotShardIndex}`,
        metricId: "hot-shard-utilization",
      });
    }
    if (d.hotUtilization >= 95 && frame.flags.hotSaturated !== 1) {
      pushEvent(next, {
        id: "hot-shard-saturated",
        at: frame.t,
        severity: "crit",
        title: "The hot shard reached its request capacity",
        detail: `Shard ${d.hotShardIndex + 1} carries ${formatCount(d.hotShardLoad)} rps while the fleet average is ${formatCount(d.averageLoad)} rps. The fleet has capacity; the mapping does not use it.`,
        nodeId: `shard-${d.hotShardIndex}`,
        metricId: "error-rate",
      });
      next.flags.hotSaturated = 1;
    }
    if (d.hotUtilization < 95) next.flags.hotSaturated = 0;
    next.flags.shardKey = d.shardKey;
    next.flags.shards = d.shardCount;
    next.summary = `${d.shardCount} shard${d.shardCount === 1 ? "" : "s"} on ${shardKeyLabel(d.shardKey)}; hottest at ${d.hotUtilization.toFixed(0)}% (${formatCount(d.hotShardLoad)} rps); ${d.errorRate.toFixed(1)}% failed requests; ${d.affinityLoss.toFixed(0)}% sessions cross shards.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = demand(p);
    const items: string[] = [];
    items.push(
      `The hottest shard carries ${formatCount(d.hotShardLoad)} rps, ${d.imbalance.toFixed(2)}× the fleet average. The average is the wrong number to size on.`,
    );
    items.push(
      `The largest tenant supplies ${(d.hotShare * 100).toFixed(0)}% of traffic. A hostname or tenant key maps it to one shard; adding shards does not split that key.`,
    );
    if (d.shardKey === 2) {
      items.push(
        "Path splitting spreads the hot tenant across shards, but it can break sessions that span paths. The affinity loss is the price of balance.",
      );
    } else if (d.shardKey === 3) {
      items.push(
        "A dedicated shard isolates the hot tenant and preserves affinity, but one tenant still cannot exceed one shard. It helps only when the tenant fits.",
      );
    } else {
      items.push(
        "Hostname and tenant-hash keys preserve affinity but can concentrate a heavy tenant. Check the mapping before adding capacity.",
      );
    }
    if (d.errorRate > 0) {
      items.push(
        `${d.errorRate.toFixed(1)}% of requests fail on the hot shard while other shards have headroom. The failure is local.`,
      );
    }
    items.push(
      `${d.effectiveShards.toFixed(1)} of ${d.shardCount} configured shards are doing effective work. That gap is the shard-key problem.`,
    );
    return items;
  },
  legend: [
    { label: "Balanced", tone: "ok" },
    { label: "Warm shard", tone: "warn" },
    { label: "Hot shard", tone: "crit" },
    { label: "No traffic", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "12 tenants, a 20% largest tenant, and three hostname shards. The hot shard is at 28%.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "40k rps with a 50% tenant on three hostname shards. The hot shard reaches the warning band.",
    tone: "warn",
    params: defaults({ requestRate: 40_000, hotTenantShare: 50, shardCount: 3, shardKey: 0 }),
  },
  {
    id: "failure",
    label: "Hot tenant",
    description: "50k rps, a 70% tenant, and three hostname shards. The hot shard is over capacity.",
    tone: "crit",
    params: defaults({ requestRate: 50_000, hotTenantShare: 70, shardCount: 3, shardKey: 0 }),
  },
  {
    id: "path-split",
    label: "Split by path",
    description: "The same 70% tenant split across four shards. Load is balanced; some sessions cross shards.",
    tone: "warn",
    params: defaults({ requestRate: 50_000, hotTenantShare: 70, shardCount: 4, shardKey: 2 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "30k rps, a 20% tenant, and four hostname shards. All shards have headroom.",
    tone: "ok",
    params: defaults({ requestRate: 30_000, hotTenantShare: 20, shardCount: 4, shardKey: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-more-shards",
  title: "Predict what a fourth shard does for a hot tenant",
  simId: "alb-sharding",
  question:
    "A 70% tenant is on shard 1 of 3 by hostname. You add a fourth ALB and keep the same hostname mapping. What happens to the hot shard?",
  prediction: {
    options: [
      { id: "same-tenant", label: "It stays hot: the tenant is one routing key and still maps to one shard" },
      { id: "even", label: "Load evens out because four shards split the tenant four ways" },
      { id: "moves", label: "It moves to the new shard automatically" },
      { id: "targets", label: "It gets worse only because the target group is smaller" },
    ],
    correctOptionId: "same-tenant",
    explanation:
      "A hostname or tenant key maps the whole tenant to one shard. Adding a shard changes the modulo space for other tenants, but the hot tenant still lands on one ALB. The hot shard may move, but it does not split. To split one tenant, you need path-level or connection-level distribution, or you need to give the tenant its own shard sized for its peak.",
  },
  setup: defaults({ requestRate: 50_000, hotTenantShare: 70, shardCount: 4, shardKey: 0 }),
  runFor: 20,
  observe: [
    "The hottest shard still carries about 37,700 rps, roughly 126% of its illustrative capacity.",
    "The fleet average is 12,500 rps, so the average suggests plenty of headroom.",
    "Failed requests stay high because the hot shard is still above capacity.",
    "The fourth shard absorbs other tenants, not the hot tenant.",
  ],
  explain:
    "Adding an ALB adds a target for the shard key to choose. It does not add a way to split one key. Hostname routing is one key per tenant, so the largest tenant remains a single shard. Only a key that splits inside the tenant, such as path or connection, can move part of its load. That split has a session cost, which is why the next step is usually a shared session store.",
  fix: defaults({ requestRate: 50_000, hotTenantShare: 70, shardCount: 4, shardKey: 2 }),
  debrief:
    "Path splitting brings the hottest shard down to about 43% and removes the errors. The cost is an illustrative 8% of sessions crossing shards. If those sessions hold carts or logins locally, the fix is incomplete; move the state to a shared store or keep hostname affinity for the session-bearing paths.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Sharding an Application Load Balancer means running several ALBs and choosing which one receives a request. The shard key is the routing input: hostname, path, tenant, source IP, or a hash. Each ALB has its own DNS name, target group, connection tables, and per-ALB limits. Sharding reduces per-ALB pressure and the blast radius of one ALB, but it also creates a routing map that has to stay consistent.",
  },
  {
    type: "p",
    text: "The hard part is not creating the ALB. It is splitting the traffic in a way that matches the session model. Hostname routing is simple: one tenant, one hostname, one shard. It preserves affinity and concentrates a heavy tenant. Path routing can split a tenant, but a session that spans paths can land on two shards. A tenant hash spreads many tenants evenly, but a single heavy tenant is still one hash. No shard key can split one key without changing where that key's sessions live.",
  },
  {
    type: "table",
    headers: ["Shard key", "What it splits", "Session behavior", "Main risk"],
    rows: [
      ["Hostname", "Tenants or subdomains", "One hostname stays on one shard", "A heavy tenant saturates its shard"],
      ["Tenant hash", "Many tenants across fixed shards", "One tenant stays on one shard", "Hash collisions and heavy tenants"],
      ["Path", "URL path groups, including inside one tenant", "A session can cross shards if it spans paths", "Affinity loss and local session state"],
      ["Dedicated shard", "One heavy tenant isolated from the rest", "Affinity preserved", "The tenant still cannot exceed one shard"],
    ],
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, Domain Name System (DNS) or Network Load Balancer (NLB), ALB shard, target group, targets. The front door chooses a shard by hostname, path, or weight. The ALB then evaluates its own listener rules and chooses a target. Each shard needs its own certificate, target group, health checks, metrics, and logs. Sticky sessions are a target-group setting and do not cross ALBs, so a client that moves shards can lose a locally stored session.",
  },
  {
    type: "compare",
    leftTitle: "One large ALB",
    rightTitle: "Sharded ALB fleet",
    rows: [
      { label: "Per-ALB pressure", left: "All tenants share one connection table", right: "Each shard has its own limit and node pool" },
      { label: "Blast radius", left: "One ALB problem affects every tenant", right: "One shard problem affects its tenants" },
      { label: "Operations", left: "One metric set, one certificate, one target group", right: "Per-shard metrics, certificates, health checks, and routing map" },
      { label: "Sessions", left: "One target group, one stickiness policy", right: "Affinity stops at the shard boundary; a shared store is safer" },
    ],
  },
  {
    type: "p",
    text: "The front door matters as much as the ALBs. Route 53 weighted records avoid an extra hop but depend on clients honoring the 60-second TTL. An NLB gives one endpoint and static IPs, but it forwards TCP to one ALB per target group; it does not make the shard key any smarter. Either way, the shard key is the design decision.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "One card per ALB shard with request load, utilization, and the hottest shard marked.",
      "The hottest-shard utilization against the fleet average, plus an imbalance multiple.",
      "Failed requests from the hot shard and sessions that cross shards.",
      "Effective shards, which shows how many shards are actually doing balanced work.",
      "Controls for total traffic, tenant count, largest-tenant share, shard count, and shard key.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Hot tenant. Read the hottest shard, not the fleet average. Add a shard without changing the key in the experiment and watch the hot shard stay hot. Switch the key to path split and watch the load balance while sessions-crossing-shards rises.",
  },
  {
    type: "table",
    headers: ["Decision", "Choose this when", "Cost"],
    rows: [
      ["Hostname per tenant", "Tenants are independent and each fits one shard", "Heavy tenants need dedicated shards or a split"],
      ["Path split for one tenant", "The tenant's paths are independent and sessions are shared", "Affinity loss on paths that share a session"],
      ["Dedicated hot-tenant shard", "One tenant is heavy but still fits one ALB", "Stranded capacity on the dedicated shard"],
      ["More shards with the same key", "The key already distributes tenants evenly", "No help for a single hot tenant"],
    ],
  },
  { type: "sim", simId: "alb-sharding" },
  { type: "experiment", experimentId: "predict-more-shards" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Three hostname shards carried a 70% tenant on one ALB. The hottest shard ran above capacity while the fleet average looked comfortable. Adding a fourth shard moved other tenants but left the hot tenant on one shard, so the errors continued. The shard count was not the constraint; the shard key was.",
  },
  {
    type: "p",
    text: "Path splitting spread the hot tenant across four shards and removed the overload. The tradeoff appeared as sessions crossing shards. With local session state, that is a correctness problem even when the load is balanced. A shared session store, or hostname affinity for session-bearing paths, is what makes the split safe.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-ALB `RequestCount`, `ActiveConnectionCount`, `NewConnectionCount`, and `HTTPCode_ELB_5XX_Count`, split by load balancer and target group.",
      "Per-target-group `RequestCountPerTarget`, `HealthyHostCount`, and `TargetResponseTime`; the hot shard has its own target group.",
      "Access logs with host and path, grouped by ALB; this is how you identify the tenant on the hot shard.",
      "Session telemetry: re-login rate, cart loss, or `NonStickyRequestCount` when stickiness is enabled.",
      "DNS or NLB weights and the time of each routing change; a weight change is a shard-map change.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the hottest shard, not the fleet average. Then list the tenants or hostnames on it. If one tenant dominates, the shard key is the problem. If many small tenants are on it, the mapping or hash is the problem. Adding shards before fixing the map leaves the hot shard hot.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the hot shard and the tenants or hostnames mapped to it.",
      "Decide whether the hot tenant fits one shard at peak.",
      "If it fits, give it a dedicated shard and move other tenants away.",
      "If it does not fit, split it by path or connection and move session state to a shared store.",
      "Only then add shards; verify the hottest shard and the effective shard count.",
      "Watch session misses and per-shard errors after the change, not just the fleet total.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More ALBs add hourly cost, certificates, target groups, health checks, and per-shard dashboards.",
      "Hostname affinity is simple but concentrates a heavy tenant on one shard.",
      "Path splitting balances load but can break sessions that span paths.",
      "A dedicated shard isolates a tenant but strands capacity when the tenant is below its peak.",
      "Sticky sessions do not cross ALBs; a shard change can force re-login unless state is shared.",
      "Per-shard observability is not optional: a fleet average can hide a saturated shard indefinitely.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-shard-key",
    question:
      "One tenant is 60% of traffic and the other 40 tenants are small. How do you shard the ALBs, and what do you measure?",
    difficulty: 3,
    hints: [
      "A single tenant is one hostname or tenant key.",
      "The fleet average hides the hot shard.",
    ],
    answer:
      "I would first check whether the large tenant fits one ALB at peak. If it does, I would give it a dedicated ALB or a dedicated target group and distribute the small tenants across the remaining shards. If it does not fit, I would split it by path or connection and move session state to a shared store, because hostname or tenant affinity cannot split one key. I would measure per-ALB request count, active connections, 5XX, and target latency, plus session misses after any split. The fleet average is not a sizing signal; the hottest shard is.",
    followUps: [
      "How would the answer change if the tenant's sessions were read-only?",
      "What would you do before adding a fifth ALB?",
      "How do you keep the shard map consistent across regions?",
    ],
    redFlags: [
      "Adds shards without changing the key.",
      "Splits a session-bearing tenant without a shared store.",
      "Sizes on the fleet average.",
    ],
    rubric: [
      "Checks whether the tenant fits one shard.",
      "Chooses a key that matches the session model.",
      "Measures per-shard, not fleet-average.",
      "Names the session tradeoff.",
    ],
  },
  {
    id: "preserve-sessions",
    question:
      "You need to split a hot tenant across two ALBs, but its cart session spans product, cart, and checkout paths. How do you preserve the session?",
    difficulty: 3,
    hints: [
      "Sticky sessions bind to a target group, not across ALBs.",
      "The session state has to live somewhere both shards can see.",
    ],
    answer:
      "I would move the session state out of the target's local memory into a shared store, such as a replicated cache or database, and make the session identifier the key. Then path or connection-level routing can send requests to either shard without losing the cart. If the application cannot be changed, I would keep hostname affinity for the session-bearing paths and split only stateless paths, which limits how much of the tenant I can distribute. I would measure session misses and re-login rate after the change, not just request success.",
    followUps: [
      "What consistency does the shared session store need?",
      "How do you handle a shard failure during checkout?",
      "Would application-based stickiness help across layers?",
    ],
    redFlags: [
      "Assumes a sticky cookie crosses ALBs.",
      "Splits all paths and hopes the session follows.",
      "Ignores session misses because HTTP 200 is high.",
    ],
    rubric: [
      "Moves state to a shared store.",
      "Keeps affinity where state is local.",
      "Measures session misses.",
      "Names the failure behavior.",
    ],
  },
  {
    id: "shard-observability",
    question:
      "What does per-shard observability need that a single fleet dashboard does not?",
    difficulty: 3,
    hints: [
      "A fleet average can hide one saturated ALB.",
      "Routing changes are part of the incident timeline.",
    ],
    answer:
      "It needs the load balancer dimension on every request, connection, error, and latency metric, plus the target-group dimension because each shard has its own target group. It needs per-shard healthy host count and target response time, and a way to map tenants or hostnames to shards. It also needs the routing map and the time of every weight or key change in the incident timeline. A fleet average is useful for capacity planning, but it cannot tell me which shard is hot or which tenant moved.",
    followUps: [
      "Which single chart would you put on the on-call dashboard?",
      "How do you alert on imbalance without alerting on normal tenant growth?",
      "How do you correlate an ALB access log with a tenant?",
    ],
    redFlags: [
      "Only monitors the fleet total.",
      "Has no tenant-to-shard mapping.",
      "Treats a routing change as unrelated to the incident.",
    ],
    rubric: [
      "Uses the load balancer and target group dimensions.",
      "Tracks the routing map.",
      "Names per-shard errors and latency.",
      "Explains why the average hides the problem.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The shard key and the tenant-to-shard mapping are documented.",
      "Dashboards show request count, connections, errors, and latency per ALB and target group.",
      "Each shard has its own certificate, target group, and health check.",
      "The session model is known: local state, shared store, or stateless.",
      "There is a plan for a tenant that outgrows one shard.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the hottest shard and the tenants on it.",
      "Decide whether the hot tenant fits one shard or must be split.",
      "Move other tenants before adding shards to the hot shard.",
      "If splitting, watch session misses as well as 5XX.",
      "Record the routing change and the time it took effect.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the hottest shard, imbalance, and effective shard count.",
      "Review the shard map for collisions and recently added tenants.",
      "Test a shard failure and a tenant move.",
      "Document the session-store dependency and its failure behavior.",
    ],
  },
];

const references = [
  {
    title: "Condition types for Application Load Balancer listener rules",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-condition-types.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Host-header, path-pattern, and other conditions used to build shard keys.",
  },
  {
    title: "Edit target group attributes for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Sticky sessions, cookie duration, cross-zone requirements, and target group behavior.",
  },
  {
    title: "CloudWatch metrics for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Per-load-balancer and per-target-group RequestCount, connection, and 5XX metrics.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "alb-sharding": {
      model: albShardingModel,
      presets,
      instructions:
        "Start Healthy, then apply Hot tenant and read the hottest shard. Add a shard without changing the key in the experiment. Switch to path split and watch load balance while sessions-crossing-shards rises. Apply Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Host-based routing, per-target-group stickiness, and per-ALB metrics are AWS-documented. The 30,000 rps shard capacity, the 8% affinity-loss estimate, and the tenant distribution are teaching values, not AWS quotas or guarantees. The model assumes the largest tenant is one routing key.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-nlb-in-front-of-alb",
    "traffic-sticky-sessions",
    "traffic-alb-lcu-cost",
  ],
};
