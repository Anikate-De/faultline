import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const QUERY_RPS = 42_000;
const BASE_LATENCY_MS = 35;

const params: ParamSpec[] = [
  {
    id: "zoneAvailable",
    label: "Authoritative zone reachable",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Scenario",
    help: "1 means the authoritative name servers answer. 0 models a zone or network failure above the service.",
    format: "count",
  },
  {
    id: "cachedResolverPct",
    label: "Resolvers with a cached answer",
    min: 0,
    max: 100,
    step: 5,
    value: 85,
    unit: "%",
    group: "Cache",
    help: "Share of clients whose resolver already holds a valid answer at the start of the outage. Cached answers keep working until the TTL expires.",
    format: "percent",
  },
  {
    id: "recordTtlS",
    label: "Record TTL",
    min: 5,
    max: 300,
    step: 5,
    value: 60,
    unit: " s",
    group: "Cache",
    help: "How long a resolver may serve the cached answer. A longer TTL delays the outage for cached clients and extends the stale window.",
    format: "number",
  },
  {
    id: "recordErrorPct",
    label: "Record error rate",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Record",
    help: "Share of authoritative answers that return NXDOMAIN for a name that should exist. This models a deleted or wrong record, not a zone outage.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Computed {
  zoneAvailable: boolean;
  cachedPct: number;
  ttl: number;
  recordError: number;
  elapsed: number;
  cacheCoverage: number;
  resolutionErrors: number;
  nxdomain: number;
  latency: number;
  resolvedQueries: number;
}

function compute(p: Params, elapsed: number): Computed {
  const zoneAvailable = num(p, "zoneAvailable", 1) >= 0.5;
  const cachedPct = clamp(num(p, "cachedResolverPct", 85), 0, 100);
  const ttl = clamp(Math.round(num(p, "recordTtlS", 60)), 5, 300);
  const recordError = clamp(num(p, "recordErrorPct", 0), 0, 100);
  const cacheCoverage = zoneAvailable ? cachedPct : cachedPct * clamp(1 - elapsed / ttl, 0, 1);
  const resolutionErrors = zoneAvailable ? recordError : 100 - cacheCoverage;
  const nxdomain = zoneAvailable ? recordError : 0;
  const latency = zoneAvailable
    ? BASE_LATENCY_MS + recordError * 1.5
    : BASE_LATENCY_MS + (100 - cacheCoverage) * 12;
  return {
    zoneAvailable,
    cachedPct,
    ttl,
    recordError,
    elapsed,
    cacheCoverage,
    resolutionErrors,
    nxdomain,
    latency,
    resolvedQueries: (QUERY_RPS * (100 - resolutionErrors)) / 100,
  };
}

function health(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function worst(a: Health, b: Health): Health {
  const rank: Record<Health, number> = { ok: 0, warn: 1, crit: 2, down: 3 };
  return rank[a] >= rank[b] ? a : b;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 7;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.97 + 0.05 * Math.sin((index + phase) / 2.4))),
    );
  }
}

function buildFrame(p: Params, elapsed: number, seed: number): SimFrame {
  const c = compute(p, elapsed);
  const clientHealth = health(c.resolutionErrors, 1, 5);
  const resolverHealth = worst(clientHealth, health(c.latency, 250, 800));
  const zoneHealth: Health = !c.zoneAvailable ? "down" : health(c.recordError, 50, 90);
  const serviceHealth: Health = "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "Client applications",
        kind: "client",
        health: clientHealth,
        utilization: clamp(c.resolutionErrors / 100),
        throughput: c.resolvedQueries,
        sublabel: `${c.resolutionErrors.toFixed(0)}% lookups failing`,
        detail:
          "Clients do not know that the failure is above the service. They report connection errors, timeouts, and provider outages.",
        meta: { view: "flow" },
      },
      {
        id: "resolver",
        label: "Recursive resolver",
        kind: "dns",
        health: resolverHealth,
        utilization: clamp(c.latency / 2_000),
        throughput: QUERY_RPS,
        sublabel: `${Math.round(c.latency)}ms · ${Math.round(c.cacheCoverage)}% cached`,
        detail:
          "The resolver answers from cache until the TTL expires, then asks the authoritative zone. When the zone is unreachable, it returns SERVFAIL after retry and timeout.",
        meta: { view: "flow" },
      },
      {
        id: "zone",
        label: "Authoritative zone",
        kind: "dns",
        health: zoneHealth,
        utilization: clamp(c.recordError / 100),
        throughput: c.zoneAvailable ? QUERY_RPS : 0,
        sublabel: c.zoneAvailable ? `${c.recordError.toFixed(0)}% NXDOMAIN` : "unreachable",
        detail:
          "The zone holds the records. It can be unreachable, or reachable and returning the wrong answer. Those are different incidents with different fixes.",
        meta: { view: "flow" },
      },
      {
        id: "api",
        label: "API service",
        kind: "service",
        health: serviceHealth,
        utilization: 0.35,
        throughput: c.resolvedQueries * 0.6,
        sublabel: "healthy",
        detail:
          "The API is healthy. Its own health check may pass because it runs inside the network and uses a cached or direct address.",
        meta: { view: "flow" },
      },
      {
        id: "payments",
        label: "Payments service",
        kind: "service",
        health: serviceHealth,
        utilization: 0.4,
        throughput: c.resolvedQueries * 0.25,
        sublabel: "healthy",
        detail:
          "A second healthy service with the same customer symptom. Independent-looking failures with one shared dependency point upward, not sideways.",
        meta: { view: "flow" },
      },
      {
        id: "cdn",
        label: "Static content",
        kind: "cdn",
        health: serviceHealth,
        utilization: 0.25,
        throughput: c.resolvedQueries * 0.15,
        sublabel: "healthy",
        detail:
          "Static content fails only when clients cannot resolve its hostname. The origin and edge may both be fine.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge(
        "clients-resolver",
        "clients",
        "resolver",
        clamp(1 - c.resolutionErrors / 100),
        clientHealth,
      ),
      edge("resolver-zone", "resolver", "zone", c.zoneAvailable ? 1 : 0, zoneHealth),
      edge("resolver-api", "resolver", "api", clamp(1 - c.resolutionErrors / 100), clientHealth),
      edge(
        "resolver-payments",
        "resolver",
        "payments",
        clamp(1 - c.resolutionErrors / 100),
        clientHealth,
      ),
      edge("resolver-cdn", "resolver", "cdn", clamp(1 - c.resolutionErrors / 100), clientHealth),
    ],
    metrics: [
      metric("resolution-errors", "Resolution errors", c.resolutionErrors, "%", 1, 5, "percent"),
      metric("nxdomain-rate", "NXDOMAIN rate", c.nxdomain, "%", 1, 5, "percent"),
      metric("resolver-latency", "Resolver latency", c.latency, "ms", 250, 800, "ms"),
      metric(
        "cached-answers",
        "Cached answer coverage",
        c.cacheCoverage,
        "%",
        undefined,
        undefined,
        "percent",
      ),
      metric(
        "resolved-queries",
        "Resolved queries",
        c.resolvedQueries,
        " q/s",
        undefined,
        undefined,
        "rps",
      ),
    ],
    events: [],
    series: {},
    flags: { seed, dnsElapsed: c.elapsed, zoneAvailable: c.zoneAvailable ? 1 : 0 },
    summary: `${c.resolutionErrors.toFixed(0)}% of lookups failing; ${Math.round(c.cacheCoverage)}% still cached; resolver latency ${Math.round(c.latency)}ms.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "resolution-errors",
    metricId: "resolution-errors",
    warn: 1,
    crit: 5,
    title: "Name resolution is failing across unrelated services",
    cause:
      "The common dependency is DNS. The authoritative zone is unreachable, a resolver path is broken, or the record is wrong. Individual services look healthy because they are healthy; clients cannot find them.",
    fix: "Confirm the failure at the resolver and authoritative zone before changing any service. Test a known-good name from multiple networks, compare cached and uncached answers, and check zone and record delegation. Fix the DNS path, then watch cache coverage recover.",
    checkFirst: [
      "Resolve the affected names from several networks and resolvers.",
      "Compare answers to a known-good name in the same zone.",
      "Check whether failures are SERVFAIL, NXDOMAIN, or timeouts.",
    ],
  },
  {
    id: "nxdomain-rate",
    metricId: "nxdomain-rate",
    warn: 1,
    crit: 5,
    title: "The zone answers, but the record is wrong",
    cause:
      "The authoritative servers are reachable and return NXDOMAIN for a name that should exist. This is a record or delegation problem, not a resolver or network outage.",
    fix: "Compare the published record with the intended value and check the delegation from the parent zone. Restore the record with a controlled TTL, then verify from public resolvers. Do not debug application capacity while the name itself does not exist.",
    checkFirst: [
      "Query the authoritative name server directly.",
      "Check the record name, type, and value against the last known good state.",
      "Check whether other names in the same zone still resolve.",
    ],
  },
  {
    id: "resolver-latency",
    metricId: "resolver-latency",
    warn: 250,
    crit: 800,
    title: "Resolvers are timing out against the authoritative zone",
    cause:
      "Uncached queries reach the unreachable zone and wait for retries and timeouts. Latency rises before total failure because cached answers are still being served.",
    fix: "Reduce the resolver timeout and retry budget so failures surface quickly, restore the authoritative path, and avoid sending all clients to one resolver. A long resolver timeout turns a DNS problem into a longer application outage.",
    checkFirst: [
      "Check resolver timeout and retry settings.",
      "Check whether the authoritative servers answer from outside the failing network.",
      "Check whether one resolver population is affected or all of them.",
    ],
  },
];

const experiment: Experiment = {
  id: "predict-dns-common-cause",
  title: "Predict the common cause of unrelated failures",
  simId: "dns-failure",
  question:
    "API, payments, and static content are all failing for customers. Each service's own dashboard is green. What do you check first?",
  prediction: {
    options: [
      { id: "service", label: "Scale up all three services" },
      { id: "dns", label: "Resolve the affected names and compare cached and uncached answers" },
      { id: "deploy", label: "Roll back the most recent deploy to each service" },
      { id: "provider", label: "Open a ticket with each service's cloud provider" },
    ],
    correctOptionId: "dns",
    explanation:
      "Independent services failing together usually share a dependency above them. Name resolution is the first shared dependency on the request path, and each service's internal health check can pass while customers cannot resolve its name. A direct DNS query distinguishes a resolver problem from a zone problem in seconds.",
  },
  setup: defaults({
    zoneAvailable: 0,
    cachedResolverPct: 90,
    recordTtlS: 20,
    recordErrorPct: 0,
  }),
  runFor: 30,
  observe: [
    "Resolution errors reach 100% after the 20-second cache window expires.",
    "Resolver latency rises above one second as uncached queries time out.",
    "All three services stay healthy; only the client lookup path fails.",
    "NXDOMAIN stays at zero, which points to SERVFAIL rather than a missing record.",
  ],
  explain:
    "Cached answers hide the outage until their TTL expires. Once the cache is empty, every lookup reaches the unreachable zone and fails. The services were never the problem, and scaling them would add cost without restoring resolution.",
  fix: defaults({
    zoneAvailable: 1,
    cachedResolverPct: 90,
    recordTtlS: 20,
    recordErrorPct: 0,
  }),
  debrief:
    "Restoring the zone restores resolution immediately. The incident review should ask why the first response was to scale three healthy services, and add a DNS check to the top of the diagnostic path.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "DNS (Domain Name System) converts a name into an address. It is the first dependency on almost every request, and it is shared by services that otherwise have nothing to do with each other. When resolution fails, the symptom appears as many unrelated service failures: the API is down, payments are down, and static content is down. Each service may be healthy the entire time.",
  },
  {
    type: "p",
    text: "The failure can sit at three layers. A recursive resolver can fail or be unreachable. The authoritative zone can stop answering. A record can be missing, wrong, or returning NXDOMAIN. NXDOMAIN means the name does not exist; SERVFAIL means the resolver could not obtain an answer. Each layer produces a different signal, and the fix is different. Cached answers add a fourth variable: some clients keep working until their time to live (TTL) expires, so the outage appears partial and moves over time.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "DNS sits above the service and below the customer. A request path is client, resolver, authoritative name server, then the service. A health check that runs inside the network may use a cached answer or a direct address, so the service looks healthy while the customer path is broken. This is why the first diagnostic step is to reproduce the lookup from the customer's side.",
  },
  {
    type: "table",
    headers: ["Signal", "Resolver failure", "Zone failure", "Record failure"],
    rows: [
      [
        "Affected clients",
        "One resolver or network",
        "All clients after cache expiry",
        "All clients that need the name",
      ],
      ["Response", "Timeout or refused", "SERVFAIL", "NXDOMAIN"],
      [
        "Other names in the zone",
        "May work through another resolver",
        "Fail",
        "Usually still work",
      ],
      ["Service health", "Healthy", "Healthy", "Healthy"],
      [
        "First fix",
        "Resolver path or config",
        "Authoritative servers or network",
        "Record or delegation",
      ],
    ],
  },
  {
    type: "p",
    text: "The values in this module are illustrative: 42,000 queries per second, a 60-second TTL, and resolver latency in milliseconds. The structure is the lesson. Cached answers delay the failure, TTL controls how long, and the response code separates a missing record from an unreachable zone.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Resolution errors: the share of lookups that fail, regardless of which service was called.",
      "NXDOMAIN rate: whether the zone answers with a missing-name response.",
      "Resolver latency: how long uncached queries wait before failing.",
      "Cached answer coverage: why some clients keep working while others fail.",
      "Service health: the healthy services behind the failing lookup path.",
    ],
  },
  {
    type: "compare",
    leftTitle: "Debug the services",
    rightTitle: "Check DNS first",
    rows: [
      {
        label: "First action",
        left: "Scale or restart each service",
        right: "Resolve the name from several networks",
      },
      { label: "Signal used", left: "Per-service errors", right: "Shared lookup path" },
      { label: "Time to cause", left: "Minutes to hours", right: "Seconds" },
      {
        label: "Risk",
        left: "Adds load and change during an outage",
        right: "Low; read-only check",
      },
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Zone unreachable. Watch resolution errors stay low while cached answers last, then jump as the TTL expires. Compare that with Record deleted, where the zone answers and NXDOMAIN rises. Run the experiment before revealing the answer, then apply Recovery and watch resolution return.",
  },
  { type: "sim", simId: "dns-failure" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the experiment, the authoritative zone became unreachable. Clients with a cached answer kept working until the 20-second TTL expired, so the outage looked partial and spread over time. Uncached queries waited through resolver retries and then failed. The API, payments, and static content stayed healthy the whole time, because none of them had failed.",
  },
  {
    type: "p",
    text: "The response code separated the failure modes. SERVFAIL pointed to the unreachable zone; NXDOMAIN in the record preset pointed to a missing name. Restoring the zone restored resolution immediately. No service needed more capacity.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A support queue with unrelated services failing from different customer networks at the same time.",
      "Service dashboards green while customer-facing error rate rises.",
      "DNS query latency and SERVFAIL or NXDOMAIN counts moving together.",
      "A wave of failures as cached answers expire, not a single sharp step.",
      "Internal health checks passing because they resolve through a different path.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Resolve the affected name from several networks and compare the answers. Query the authoritative name server directly and check whether the failure is a timeout, SERVFAIL, or NXDOMAIN. Compare a known-good name in the same zone. Only after DNS is ruled out should you change service capacity or roll back a deploy.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Reproduce the lookup from the customer side, not from inside the service network.",
      "Classify the response: timeout, SERVFAIL, or NXDOMAIN.",
      "Check the authoritative zone and the delegation from the parent zone.",
      "Restore the zone, resolver path, or record, whichever the signal identifies.",
      "Verify resolution from public resolvers and multiple networks.",
      "Watch cache coverage recover and confirm customer traffic returns.",
      "Add a DNS check to the first five minutes of the diagnostic runbook.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A long TTL reduces query volume and keeps working during a zone outage, but extends the stale window and slows a planned change.",
      "A short TTL speeds convergence and failure detection, but increases resolver load and makes the service more dependent on the zone.",
      "Multiple resolvers improve resilience but make the failure surface harder to reason about.",
      "Caching answers protects clients during a short outage but hides the outage until the cache expires, which can delay detection.",
      "Moving the record to a second provider can restore service quickly but adds a delegation and consistency risk.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-dns",
    question:
      "Every service is failing and every service dashboard is green. How do you confirm DNS?",
    difficulty: 3,
    hints: [
      "Reproduce the customer path, not the internal path.",
      "Compare cached and uncached answers.",
    ],
    answer:
      "I resolve the affected name from multiple networks and compare with a known-good name. I query the authoritative name server directly and classify the result as timeout, SERVFAIL, or NXDOMAIN. I check whether internal health checks use a different resolver or a cached answer. If the failure is above the service, I confirm the zone and delegation before changing any service capacity.",
    followUps: [
      "What does NXDOMAIN tell you that SERVFAIL does not?",
      "How do cached answers change the timeline?",
      "What would you check if only one network is affected?",
    ],
    redFlags: [
      "Restarts services before checking resolution.",
      "Trusts an internal health check.",
      "Treats all DNS errors as the same failure.",
    ],
    rubric: [
      "Reproduces from the client side.",
      "Classifies the response code.",
      "Checks zone and delegation.",
      "Avoids service changes.",
    ],
  },
  {
    id: "record-vs-zone",
    question: "How do you distinguish a deleted record from an unreachable zone?",
    difficulty: 3,
    hints: [
      "The response code is the fastest discriminator.",
      "Check other names in the same zone.",
    ],
    answer:
      "A deleted record returns NXDOMAIN from a reachable authoritative server, and other names in the same zone still resolve. An unreachable zone returns SERVFAIL or times out, and every uncached name in the zone fails. I confirm by querying the authoritative server directly and checking the delegation. The fix differs: restore the record versus restore the zone or its network path.",
    followUps: [
      "What if the record exists but points to the wrong address?",
      "How does a CNAME change the diagnosis?",
      "What does a lame delegation look like?",
    ],
    redFlags: [
      "Assumes every DNS failure is a zone outage.",
      "Changes the record without checking delegation.",
      "Ignores other names in the zone.",
    ],
    rubric: [
      "Uses response codes.",
      "Checks other names.",
      "Checks authoritative servers.",
      "Maps signal to fix.",
    ],
  },
  {
    id: "communicate-dns",
    question: "How do you communicate a DNS outage while the cause is still unconfirmed?",
    difficulty: 2,
    hints: ["State known impact, not a hypothesis.", "Give the next update time."],
    answer:
      "I would say that customers may be unable to reach affected services, that the team is investigating name resolution as one possible shared cause, and that the next update will come at a stated time. I would not name a provider, a record, or a root cause until it is confirmed. Support gets the same statement and a route for new symptoms.",
    followUps: [
      "When do you name the cause?",
      "What if a provider confirms an outage?",
      "How do you avoid blaming the customer's network?",
    ],
    redFlags: [
      "Publishes an unconfirmed cause.",
      "Blames a provider before confirmation.",
      "Gives no next update time.",
    ],
    rubric: [
      "States impact.",
      "Avoids speculation.",
      "Commits to a next update.",
      "Equips support.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The diagnostic runbook starts with a DNS lookup from the customer path.",
      "TTLs are documented for customer-facing records and planned changes.",
      "Health checks do not rely only on an internal cached answer.",
      "Resolver and authoritative-zone signals share one dashboard.",
      "A second DNS provider or delegation path is tested where required.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Reproduce the lookup from multiple networks before changing services.",
      "Classify each failure as timeout, SERVFAIL, or NXDOMAIN.",
      "Query the authoritative server directly and check delegation.",
      "Restore the zone, resolver path, or record that the signal identifies.",
      "Tell customers the known impact and the next update time without naming an unconfirmed cause.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Compare the outage timeline with TTL expiry across resolver populations.",
      "Check whether internal health checks masked the customer failure.",
      "Review why service changes were attempted before DNS was checked.",
      "Update the runbook and the resolver timeout budget.",
    ],
  },
];

const references = [
  {
    title: "What is Amazon Route 53?",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/Welcome.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Authoritative DNS, records, routing policies, and health checks.",
  },
  {
    title: "Addressing Cascading Failures",
    url: "https://sre.google/sre-book/addressing-cascading-failures/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "How a shared dependency turns into many unrelated-looking service failures.",
  },
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Communication and coordination while the cause is still unknown.",
  },
];

export const dnsFailureModel: SimModel = {
  id: "reliability-dns-failure",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const zoneAvailable = num(p, "zoneAvailable", 1) >= 0.5;
    const wasAvailable = frame.flags.zoneAvailable !== 0;
    const previous = Math.max(0, Number(frame.flags.dnsElapsed ?? 0));
    const elapsed = zoneAvailable ? 0 : wasAvailable ? Math.max(0, dt) : previous + Math.max(0, dt);
    const c = compute(p, elapsed);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, elapsed, seed);
    next.t = frame.t;
    next.flags = {
      ...frame.flags,
      ...next.flags,
      dnsElapsed: elapsed,
      zoneAvailable: zoneAvailable ? 1 : 0,
    };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events].slice(-60);

    if (!zoneAvailable && wasAvailable) {
      pushEvent(next, {
        id: "dns-zone-unreachable",
        at: frame.t,
        severity: "warn",
        title: "Authoritative DNS is unreachable",
        detail: `Cached answers cover ${Math.round(c.cacheCoverage)}% of clients for up to ${c.ttl}s. After that, uncached lookups will fail.`,
        nodeId: "zone",
        metricId: "resolution-errors",
      });
    }
    if (!zoneAvailable && c.cacheCoverage === 0 && frame.flags.dnsCacheExpired !== 1) {
      pushEvent(next, {
        id: "dns-cache-expired",
        at: frame.t,
        severity: "crit",
        title: "Cached answers are exhausted",
        detail: `Resolution errors reached ${c.resolutionErrors.toFixed(0)}% and resolver latency is ${Math.round(c.latency)}ms. The services behind the names are still healthy.`,
        nodeId: "resolver",
        metricId: "resolution-errors",
      });
      next.flags.dnsCacheExpired = 1;
    }
    if (zoneAvailable) next.flags.dnsCacheExpired = 0;
    if (c.nxdomain >= 5 && frame.flags.dnsRecordEvent !== 1) {
      pushEvent(next, {
        id: "dns-record-wrong",
        at: frame.t,
        severity: "crit",
        title: "The zone answers NXDOMAIN for a valid name",
        detail: `${c.nxdomain.toFixed(0)}% of authoritative answers report that the name does not exist. The zone is reachable, so the record or delegation is wrong.`,
        nodeId: "zone",
        metricId: "nxdomain-rate",
      });
      next.flags.dnsRecordEvent = 1;
    }
    if (c.nxdomain < 5) next.flags.dnsRecordEvent = 0;
    if (
      zoneAvailable &&
      c.recordError === 0 &&
      c.resolutionErrors === 0 &&
      frame.flags.dnsRecovered !== 1
    ) {
      pushEvent(next, {
        id: "dns-recovered",
        at: frame.t,
        severity: "info",
        title: "Name resolution recovered",
        detail: `Resolution errors are zero and cached coverage is rebuilding. Confirm from public resolvers before closing the incident.`,
        nodeId: "resolver",
        metricId: "resolution-errors",
      });
      next.flags.dnsRecovered = 1;
    }
    if (!zoneAvailable || c.resolutionErrors > 0) next.flags.dnsRecovered = 0;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const c = compute(p, Math.max(0, Number(frame.flags.dnsElapsed ?? 0)));
    const items: string[] = [];
    items.push(
      `Resolution errors are ${c.resolutionErrors.toFixed(0)}%. ${c.cacheCoverage > 0 ? `${Math.round(c.cacheCoverage)}% of clients still have a cached answer.` : "No cached answers remain."}`,
    );
    items.push(
      c.zoneAvailable
        ? `The authoritative zone is reachable. ${c.nxdomain.toFixed(0)}% of answers are NXDOMAIN, which points to the record or delegation.`
        : "The authoritative zone is unreachable. Uncached queries will return SERVFAIL after resolver retries.",
    );
    items.push(
      `Resolver latency is ${Math.round(c.latency)}ms. The services themselves report healthy, so capacity changes will not restore resolution.`,
    );
    items.push(
      "Check DNS from the customer path first. A cached internal health check can pass while every customer lookup fails.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Resolver slow", tone: "warn" },
    { label: "Resolution failing", tone: "crit" },
    { label: "Zone unreachable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description:
      "The zone answers, records are correct, and 85% of resolvers hold a cached answer.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Record warnings",
    description:
      "The zone is reachable, but 2% of answers return NXDOMAIN. Resolution works for most clients.",
    tone: "warn",
    params: defaults({ recordErrorPct: 2 }),
  },
  {
    id: "failure",
    label: "Zone unreachable",
    description:
      "The authoritative zone is down. Only 20% of resolvers have a cached answer, and the TTL is 10 seconds.",
    tone: "crit",
    params: defaults({ zoneAvailable: 0, cachedResolverPct: 20, recordTtlS: 10 }),
  },
  {
    id: "record-deleted",
    label: "Record deleted",
    description:
      "The zone is reachable and answers NXDOMAIN for the customer-facing name. The services are healthy.",
    tone: "crit",
    params: defaults({ zoneAvailable: 1, cachedResolverPct: 0, recordErrorPct: 100 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "The zone is reachable again and records are correct. Resolution returns without service changes.",
    tone: "ok",
    params: defaults({
      zoneAvailable: 1,
      cachedResolverPct: 20,
      recordTtlS: 10,
      recordErrorPct: 0,
    }),
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "dns-failure": {
      model: dnsFailureModel,
      presets,
      instructions:
        "Start Healthy, then apply Zone unreachable. Watch resolution errors stay low while cached answers last, then rise as the TTL expires. Compare with Record deleted, where NXDOMAIN rises while the zone stays reachable. Apply Recovery and confirm resolution returns.",
      experimentIds: [experiment.id],
      alternateVisuals: ["topology", "heatmap"],
      note: "Illustrative model. Query rate, TTL, and latency values are teaching examples, not a specific DNS provider's limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-dns-ttl-failover",
    "reliability-dependency-failure",
    "reliability-status-pages",
    "reliability-customer-comms",
  ],
};
