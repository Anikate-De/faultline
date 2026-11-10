import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ENTRIES_PER_FLOW = 2;

const params = [
  {
    id: "newConnPerSec",
    label: "New connections",
    min: 100,
    max: 20_000,
    step: 100,
    value: 400,
    unit: " conn/s",
    group: "Traffic",
    help: "Connections initiated per second through the NAT device. Established connections do not consume a new entry.",
    format: "rps" as const,
  },
  {
    id: "flowDuration",
    label: "Flow duration",
    min: 10,
    max: 600,
    step: 10,
    value: 120,
    unit: " s",
    group: "Traffic",
    help: "How long each flow stays active. Longer flows keep entries in the table longer.",
    format: "number" as const,
  },
  {
    id: "entryTimeout",
    label: "Tracked-entry timeout",
    min: 30,
    max: 600,
    step: 30,
    value: 120,
    unit: " s",
    group: "Limits",
    help: "How long an entry survives after the last packet. Shorter than the flow duration, it forgets active flows.",
    format: "number" as const,
  },
  {
    id: "tableSize",
    label: "Tracking table size",
    min: 16_384,
    max: 524_288,
    step: 16_384,
    value: 262_144,
    unit: " entries",
    group: "Limits",
    help: "Maximum tracked entries. The kernel stores an original and a reply entry per flow, so capacity is roughly half this number of flows.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  flows: number;
  demandedEntries: number;
  entries: number;
  utilization: number;
  brokenFlows: number;
  dropRate: number;
  newConnPerSec: number;
  timeout: number;
  duration: number;
  headroom: number;
}

function compute(p: Params): Computed {
  const newConnPerSec = num(p, "newConnPerSec", 400);
  const duration = num(p, "flowDuration", 120);
  const timeout = num(p, "entryTimeout", 120);
  const tableSize = Math.max(1_024, num(p, "tableSize", 262_144));

  const activeLifetime = Math.min(duration, timeout) + 0.25 * Math.max(0, timeout - duration);
  const flows = newConnPerSec * activeLifetime;
  const demandedEntries = flows * ENTRIES_PER_FLOW;
  const entries = Math.min(demandedEntries, tableSize);
  const utilization = (entries / tableSize) * 100;
  const overflow = Math.max(0, demandedEntries - tableSize);
  const brokenFlows =
    timeout < duration ? newConnPerSec * (1 - timeout / duration) : 0;
  const dropRate =
    demandedEntries > tableSize
      ? newConnPerSec * Math.min(0.9, overflow / demandedEntries)
      : 0;
  return {
    flows,
    demandedEntries,
    entries,
    utilization,
    brokenFlows,
    dropRate,
    newConnPerSec,
    timeout,
    duration,
    headroom: Math.max(0, tableSize - demandedEntries),
  };
}

function healthFor(utilization: number): "ok" | "warn" | "crit" {
  if (utilization >= 90) return "crit";
  if (utilization >= 70) return "warn";
  return "ok";
}

function demandHealth(dropRate: number, brokenFlows: number): "ok" | "warn" | "crit" {
  if (dropRate >= 50 || brokenFlows >= 500) return "crit";
  if (dropRate >= 1 || brokenFlows >= 10) return "warn";
  return "ok";
}

function worst(a: "ok" | "warn" | "crit", b: "ok" | "warn" | "crit"): "ok" | "warn" | "crit" {
  const rank = { ok: 0, warn: 1, crit: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const health = healthFor(values.utilization);
  const state = worst(health, demandHealth(values.dropRate, values.brokenFlows));
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Private subnets",
        kind: "client",
        health: "ok",
        sublabel: `${Math.round(values.newConnPerSec).toLocaleString()} new flows/s`,
        meta: { view: "flow" },
      },
      {
        id: "nat",
        label: "NAT gateway",
        kind: "service",
        health: state,
        utilization: clamp(values.utilization / 100),
        throughput: values.newConnPerSec,
        capacity: values.newConnPerSec - values.dropRate,
        sublabel: `${Math.round(values.dropRate).toLocaleString()} drops/s`,
        detail: `Translates private addresses and ports. Each flow consumes two tracking entries, one per direction. The table holds ${Math.round(values.entries).toLocaleString()} of ${Math.round(values.demandedEntries).toLocaleString()} demanded entries.`,
        meta: { view: "flow", utilization: values.utilization },
      },
      {
        id: "table",
        label: "Conntrack table",
        kind: "storage",
        role: "instance",
        health: state,
        utilization: clamp(values.utilization / 100),
        sublabel: `${Math.round(values.entries).toLocaleString()} / ${Math.round(values.demandedEntries).toLocaleString()} entries`,
        detail: "Tracks the five-tuple, NAT translation, and state timeouts. The table is capped at its configured size; excess demand is dropped while established flows continue.",
        meta: { view: "flow" },
      },
      {
        id: "destination",
        label: "External endpoint",
        kind: "external",
        health: "ok",
        sublabel: "one IP per destination",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-nat", "client", "nat", clamp(values.newConnPerSec / 20_000), state),
      edge("nat-table", "nat", "table", clamp(values.utilization / 100), state),
      edge("nat-destination", "nat", "destination", clamp((values.newConnPerSec - values.dropRate) / 20_000)),
    ],
    metrics: [
      metric("table-utilization", "Tracking table used", values.utilization, "%", 70, 90, "percent"),
      metric("drop-rate", "New flows dropped", values.dropRate, " conn/s", 1, 50, "rps"),
      metric("broken-flows", "Flows forgotten early", values.brokenFlows, " flows/s", 10, 500, "rps"),
      metric("tracked-entries", "Tracked entries", values.entries, " entries", undefined, undefined, "count"),
      metric("demanded-entries", "Demanded entries", values.demandedEntries, " entries", undefined, undefined, "count"),
      metric("new-connections", "New connections", values.newConnPerSec, " conn/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.utilization.toFixed(0)}% of the tracking table used; ${Math.round(values.demandedEntries).toLocaleString()} entries demanded; ${Math.round(values.dropRate)} drops/s; ${Math.round(values.brokenFlows)} broken flows/s.`,
  };
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.9);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, item.value * jitter(index + item.id.length)),
    );
  }
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "table-utilization",
    metricId: "table-utilization",
    warn: 70,
    crit: 90,
    title: "The connection tracking table is filling",
    cause:
      "New flows are arriving faster than entries expire, or entries live too long. Each flow consumes two entries, so the usable flow count is about half the table limit.",
    fix:
      "Reduce connection churn, close idle connections, shorten the entry lifetime where safe, and add NAT capacity or split destinations across gateways. Raising only the table limit delays the crossing if churn is unbounded.",
    checkFirst: [
      "Compare new-connection rate with the entry timeout and flow duration.",
      "Check table count against the configured maximum.",
      "Check whether one destination or one client dominates the table.",
    ],
  },
  {
    id: "drop-rate",
    metricId: "drop-rate",
    warn: 1,
    crit: 50,
    title: "New connections are being dropped at the NAT device",
    cause:
      "The table or the NAT source-port pool is exhausted. Existing flows keep working, so the failure looks intermittent: some new connections succeed and others time out.",
    fix:
      "Free capacity by closing idle or stale connections and reducing churn, then add NAT gateways or addresses. Confirm that retries are not multiplying new flows.",
    checkFirst: [
      "Check NAT error or port-allocation metrics.",
      "Check active connections per destination and per gateway.",
      "Check whether clients retry aggressively after a timeout.",
    ],
  },
  {
    id: "broken-flows",
    metricId: "broken-flows",
    warn: 10,
    crit: 500,
    title: "Entries are expiring while flows are still active",
    cause:
      "The tracked-entry timeout is shorter than the flow duration. The device forgets an active mapping, then later packets create a new mapping, so the flow breaks and retries look like new connections.",
    fix:
      "Set the timeout at or above the longest legitimate flow, and keep application keep-alives inside that window. Do not shorten timeouts to save table space when flows are long-lived.",
    checkFirst: [
      "Compare the TCP established or idle timeout with the application's connection lifetime.",
      "Check for RSTs, retransmits, and reconnects at the client.",
      "Check whether the failure started after a timeout change.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const conntrackModel: SimModel = {
  id: "foundations-conntrack",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    const values = compute(p);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.4, 0.4);
    next.metrics = next.metrics.map((item) =>
      item.id === "drop-rate" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.brokenFlows > 0 && frame.flags.timeoutWarned !== 1) {
      pushEvent(next, {
        id: "conntrack-timeout-short",
        at: frame.t,
        severity: values.brokenFlows >= 500 ? "crit" : "warn",
        title: "Entry timeout is shorter than the flow duration",
        detail: `Flows last ${values.duration}s but entries expire after ${values.timeout}s. About ${Math.round(values.brokenFlows)} flows per second lose their mapping and are recreated.`,
        nodeId: "table",
        metricId: "broken-flows",
      });
      next.flags.timeoutWarned = 1;
    }
    if (values.brokenFlows === 0) next.flags.timeoutWarned = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${values.utilization.toFixed(0)}% of the tracking table used; ${Math.round(values.demandedEntries).toLocaleString()} entries demanded; ${Math.round(values.dropRate)} drops/s; ${Math.round(values.brokenFlows)} broken flows/s.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `${Math.round(values.flows).toLocaleString()} concurrent flows need about ${Math.round(values.entries).toLocaleString()} entries because conntrack stores both directions.`,
    );
    if (values.utilization >= 70) {
      items.push(
        `The table holds ${Math.round(values.entries).toLocaleString()} of ${Math.round(values.demandedEntries).toLocaleString()} demanded entries; ${Math.round(values.dropRate)} new flows per second are being dropped.`,
      );
    } else {
      items.push(`The table is ${values.utilization.toFixed(0)}% full, so new flows still have room.`);
    }
    if (values.timeout < values.duration) {
      items.push(
        `The ${values.timeout}s timeout is shorter than the ${values.duration}s flow, so ${Math.round(values.brokenFlows)} of ${Math.round(values.newConnPerSec)} new flows/s are forgotten mid-stream and retried.`,
      );
    } else {
      items.push("The timeout covers the full flow duration, so entries are not expiring mid-stream.");
    }
    items.push(
      "Bandwidth can be nearly idle during this failure: the constraint is table state and port allocation, not bytes per second.",
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
    description: "Steady connection churn with the timeout matched to flow duration.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Higher churn and a longer timeout. The table is warm but not dropping.",
    tone: "warn",
    params: defaults({ newConnPerSec: 800, flowDuration: 120, entryTimeout: 180, tableSize: 262_144 }),
  },
  {
    id: "failure",
    label: "Table full",
    description: "Long flows and high churn fill the table; new connections fail while established flows continue.",
    tone: "crit",
    params: defaults({ newConnPerSec: 1_500, flowDuration: 300, entryTimeout: 120, tableSize: 262_144 }),
  },
  {
    id: "timeout-cut",
    label: "Cut the timeout",
    description: "Shorter timeout frees table space but forgets active flows and raises churn.",
    tone: "warn",
    params: defaults({ newConnPerSec: 900, flowDuration: 300, entryTimeout: 60, tableSize: 262_144 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Longer timeout, lower churn, and more table capacity.",
    tone: "ok",
    params: defaults({ newConnPerSec: 500, flowDuration: 300, entryTimeout: 300, tableSize: 524_288 }),
  },
];

const experiment: Experiment = {
  id: "predict-conntrack-timeout",
  title: "Predict what cutting the timeout does",
  simId: "conntrack",
  question:
    "Flows last 300 seconds and the tracking table is full. You cut the entry timeout from 240 seconds to 60 seconds. What happens?",
  prediction: {
    options: [
      { id: "frees", label: "Table usage falls and the outage clears" },
      { id: "falls-breaks", label: "Table usage falls, but active flows break and retry churn rises" },
      { id: "unchanged", label: "Nothing changes because bandwidth is the limit" },
      { id: "worse-table", label: "Table usage rises immediately" },
    ],
    correctOptionId: "falls-breaks",
    explanation:
      "A shorter timeout releases entries sooner, so occupancy falls. But the timeout is now far below the flow duration, so the device forgets mappings for flows that are still active. Later packets create new entries and the client retries, adding churn. The table may stay below its limit while the application still fails.",
  },
  setup: defaults({ newConnPerSec: 900, flowDuration: 300, entryTimeout: 240, tableSize: 262_144 }),
  runFor: 30,
  observe: [
    "Table utilization starts critical because 900 flows/s multiplied by a long lifetime exceeds the table.",
    "Dropped new connections appear while the established flows keep moving bytes.",
    "The tracking table reads 100%, not more; demanded entries show the overload.",
    "Cutting the timeout lowers utilization but raises flows forgotten early.",
    "The client sees timeouts and reconnects even though the table no longer looks full.",
  ],
  explain:
    "The table is a stateful resource with two costs: occupied entries and the churn created when those entries disappear. A timeout must be at least as long as the longest legitimate flow, or the device will forget an active mapping. The durable fix is to lower churn or add NAT capacity, and to keep retries bounded so a partial failure does not multiply the flow rate.",
  fix: defaults({ newConnPerSec: 500, flowDuration: 300, entryTimeout: 300, tableSize: 524_288 }),
  debrief:
    "The recovered run has enough table for the flow count, a timeout that covers the flow, and no early expirations. The tradeoff is that long timeouts hold entries for closed flows, so capacity must be sized for the peak flow count rather than the average.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Connection tracking, or conntrack, is the kernel subsystem that remembers network flows so Network Address Translation (NAT) and stateful firewalls can treat packets as part of a conversation. An entry is keyed by a five-tuple: source address, source port, destination address, destination port, and protocol. For NAT, the entry also stores the translated address and port, so return traffic can be mapped back to the right private client.",
  },
  {
    type: "p",
    text: "The table is finite. The kernel allocates an original-direction entry and a reply-direction entry for each tracked flow, so one flow consumes roughly two entries. When the table is full, new flows are dropped while existing flows continue. That produces the signature symptom: established traffic works, but new connections fail intermittently, and bandwidth can be nearly idle. Timeouts are the other half of the model. An entry survives for a state-dependent timeout after the last packet; if that timeout is shorter than the flow, the device forgets an active mapping and the flow breaks.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "A private client sends a packet to a public destination. The NAT device creates a tracking entry, rewrites the source address and port, and forwards the packet. Return traffic matches the entry and is translated back. The path is client, NAT gateway or NAT instance, conntrack table, destination. On Linux the table is visible through nf_conntrack_count and nf_conntrack_max; conntrack-tools can list and count entries. In a managed NAT service the table is hidden, so you watch connection counts, port allocation errors, and drops instead.",
  },
  {
    type: "table",
    headers: ["Layer", "What is finite", "Signal when it runs out"],
    rows: [
      ["Tracking table", "Entries for active and recently active flows", "Table full; new flows dropped"],
      ["NAT port pool", "Source ports per address and destination", "Port allocation errors; connect timeouts"],
      ["Idle timeout", "How long an unused mapping survives", "Stale mappings or connections reset after idle"],
      ["Bandwidth", "Bytes per second on the path", "Throughput plateau, not connection-level failures"],
    ],
  },
  {
    type: "p",
    text: "AWS NAT gateways are managed and do not expose nf_conntrack tuning. AWS documents a 350-second idle timeout and a per-address concurrent-connection limit, with CloudWatch metrics for connection attempts, established connections, idle timeouts, and port allocation errors. A generic Linux NAT instance exposes the kernel table and its timeouts directly. The simulation uses a generic tracking table at 100–20,000 new flows per second; the values are illustrative, not an AWS quota.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Tracking table used: the percentage of the entry limit, with warning at 70% and critical at 90%.",
      "New flows dropped: connections refused for lack of a table entry or source port.",
      "Flows forgotten early: active flows whose entry expired because the timeout was too short.",
      "Tracked entries: the absolute occupancy, which separates churn from a single long-lived flow.",
      "New connections: the arrival rate driving table pressure.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Table full. Notice that dropped new connections rise while the connection count is still high. Apply Cut the timeout and watch table usage fall while forgotten flows rise. Run the experiment before reading its explanation, then apply Recovery.",
  },
  {
    type: "compare",
    leftTitle: "Table exhaustion",
    rightTitle: "Bandwidth saturation",
    rows: [
      { label: "New connections", left: "Fail or time out", right: "Succeed slowly" },
      { label: "Established flows", left: "Often continue", right: "All flows slow down" },
      { label: "Throughput", left: "Can be low", right: "At or near link rate" },
      { label: "Primary signal", left: "Table count and drops", right: "Bytes/s and queue drops" },
    ],
  },
  { type: "sim", simId: "conntrack" },
  { type: "experiment", experimentId: "predict-conntrack-timeout" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "New connections arrived faster than entries expired. Because each flow needs two entries, the usable flow count was about half the table size. Once the table filled, new flows were dropped while existing flows continued, so the failure looked partial and intermittent. Cutting the timeout reduced occupancy but also reduced the time an active mapping survived, so flows broke and retried.",
  },
  {
    type: "p",
    text: "The recovery raised table capacity, lowered churn, and set the timeout to cover the flow duration. That removed both failure modes: no table exhaustion and no mid-flow forgetting. The remaining tradeoff is memory and cost: a larger table and longer timeouts hold state for closed or idle flows, so capacity must be sized for peak concurrency, not average traffic.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Linux: `cat /proc/sys/net/netfilter/nf_conntrack_count` and `nf_conntrack_max`, `conntrack -S` for invalid, drop, and insert-failed counters, and `dmesg` for `nf_conntrack: table full, dropping packet`.",
      "AWS NAT gateway: `ActiveConnectionCount`, `ConnectionAttemptCount`, `ConnectionEstablishedCount`, `ErrorPortAllocation`, `IdleTimeoutCount`, and `PacketsDropCount` in CloudWatch.",
      "Clients: connect timeouts, SYN retries, and `cannot assign requested address` when the local port range is exhausted.",
      "Application logs: intermittent connection failures to one destination while other calls succeed, often with retries that increase load.",
      "Traces: established calls stay fast; new spans fail before the first byte, which places the fault before the application.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the tracking table count against its maximum, then check port-allocation errors and the new-connection rate. If established flows are healthy and only new ones fail, suspect table or port exhaustion before bandwidth.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the NAT layer is the failure point: new connections fail while established flows and bandwidth look normal.",
      "Check table occupancy, port-allocation errors, and per-destination connection counts.",
      "Reduce churn: close idle connections, reuse connections, and bound client retries.",
      "Raise the timeout only up to the longest legitimate flow; shortening it below that breaks active flows.",
      "Add NAT capacity or addresses, or split destinations across gateways, and verify the limit per destination.",
      "Load-test the new connection rate and confirm drops and port errors stay at zero at peak.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger table costs memory and may hide unbounded churn; it is capacity, not a churn fix.",
      "A longer timeout holds closed flows longer, consuming entries that new flows could use.",
      "A shorter timeout frees entries sooner but breaks flows that outlive it, causing retries and duplicate work.",
      "More NAT gateways add capacity and availability but multiply cost and complicate per-destination limits.",
      "Connection pooling reduces new-flow rate but holds state longer, so the pool size and idle timeout must be aligned with the NAT timeout.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-conntrack",
    question:
      "New connections to one external API fail intermittently, but established calls and bandwidth are normal. How do you determine whether conntrack is the cause?",
    difficulty: 3,
    hints: [
      "The failure is per-flow, not per-byte.",
      "Check table count and port allocation before the application.",
    ],
    answer:
      "I would first confirm the failure is at connection setup: new spans fail before the first byte, while established calls stay fast and throughput is well below the link rate. Then I would check the NAT layer. On Linux, nf_conntrack_count against nf_conntrack_max, conntrack -S for insert failures, and dmesg for table-full messages. On an AWS NAT gateway, ErrorPortAllocation, ActiveConnectionCount, and the gap between connection attempts and established connections. I would also check the client ephemeral port range and whether one destination dominates the table. That evidence separates table exhaustion from bandwidth, DNS, or application errors.",
    followUps: [
      "Why does each flow consume two entries?",
      "What would you check if only one destination fails?",
      "How do retries change the diagnosis?",
    ],
    redFlags: [
      "Starts with bandwidth graphs.",
      "Assumes the application is at fault because some calls succeed.",
      "Ignores per-destination limits.",
    ],
    rubric: [
      "Localizes the failure to connection setup.",
      "Names table and port-allocation signals.",
      "Checks retries and per-destination concentration.",
      "States what would falsify the hypothesis.",
    ],
  },
  {
    id: "timeout-tradeoff",
    question:
      "The conntrack table is full. A teammate proposes cutting the entry timeout from 300 seconds to 60 seconds. What do you say?",
    difficulty: 3,
    hints: [
      "Timeout is not free capacity.",
      "Compare the timeout with the longest legitimate flow.",
    ],
    answer:
      "Cutting the timeout will lower occupancy for flows that have already closed, but it will also expire mappings for flows that are still active if the timeout is shorter than their duration. Those flows break, clients retry, and the retry churn can refill the table or at least keep the failure going. I would first check the actual flow duration and whether the timeout is already below it. If so, shortening it makes the application failure worse. The durable options are reducing connection churn, closing idle connections, and adding NAT capacity.",
    followUps: [
      "How would you measure the longest legitimate flow?",
      "What is the risk of making the timeout very long?",
      "How do keep-alives interact with the timeout?",
    ],
    redFlags: [
      "Treats timeout as a free capacity knob.",
      "Ignores active flow duration.",
      "Does not consider retry amplification.",
    ],
    rubric: [
      "Explains the occupancy benefit.",
      "Explains mid-flow expiration.",
      "Connects retries to churn.",
      "Proposes a safer capacity fix.",
    ],
  },
  {
    id: "nat-design",
    question:
      "A private-subnet workload opens 2,000 new connections per second to many destinations, with flows lasting five minutes. How would you design NAT capacity and what would you monitor?",
    difficulty: 4,
    hints: [
      "Estimate concurrent flows first.",
      "Per-destination limits matter, not just the total.",
    ],
    answer:
      "At 2,000 new flows per second and 300 seconds per flow, the steady-state flow count is about 600,000. Each flow costs roughly two tracking entries, so I would size for more than 1.2 million entries before headroom, which is beyond a single generic Linux table and well beyond a single managed NAT address. I would reduce churn with connection pooling and keep-alives, split destinations and clients across multiple NAT gateways or addresses, and check the per-destination limit rather than only the aggregate. I would monitor active connections, new attempts versus established connections, port-allocation errors, idle timeouts, table count against maximum, and client connect latency. I would also test failover, because losing one NAT gateway moves its flows to the others.",
    followUps: [
      "What would you change if flows lasted 30 seconds instead?",
      "How does connection pooling change the estimate?",
      "What happens to established flows when a NAT gateway fails?",
    ],
    redFlags: [
      "Sizes only from bandwidth.",
      "Ignores per-destination limits.",
      "Forgets headroom and failover.",
    ],
    rubric: [
      "Uses Little's Law for concurrent flows.",
      "Accounts for two entries per flow.",
      "Includes per-destination and failover constraints.",
      "Names concrete monitoring signals.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "NAT capacity is sized from peak concurrent flows, including headroom for one gateway or address loss.",
      "Per-destination connection limits are understood and monitored.",
      "Entry timeouts are at least as long as the longest legitimate flow and longer than application keep-alives.",
      "Clients bound retries and reuse connections instead of reconnecting per request.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm that established flows work and new connections fail before blaming bandwidth.",
      "Check table occupancy, port-allocation errors, and per-destination counts.",
      "Reduce churn and close idle connections before changing timeout values.",
      "Add NAT capacity or addresses, and watch for retry amplification.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify new-connection success and table occupancy at peak.",
      "Remove temporary timeout changes and reconcile them with application keep-alives.",
      "Document the per-destination limit and the failover behavior.",
      "Add an alert on table slope and port-allocation errors, not only on utilization.",
    ],
  },
];

const references = [
  {
    title: "Netfilter Conntrack Sysfs variables",
    url: "https://docs.kernel.org/networking/nf_conntrack-sysctl.html",
    publisher: "Linux kernel documentation",
    kind: "docs" as const,
    note: "Table size, timeouts, and the two-entry-per-flow accounting.",
  },
  {
    title: "NAT gateways",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Managed NAT behavior and connectivity model.",
  },
  {
    title: "Troubleshoot NAT gateways",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-troubleshooting.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "350-second idle timeout and the 55,000-connection per-address limit.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    conntrack: {
      model: conntrackModel,
      presets,
      instructions:
        "Start healthy, fill the table, then cut the timeout. Watch dropped new flows and forgotten active flows separately; they have different causes.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Table sizes and timeouts are teaching values, not an AWS NAT gateway quota.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-linux-network-saturation",
    "case-composite-nat-ports",
    "traffic-l4-vs-l7",
  ],
};
