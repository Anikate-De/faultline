import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_RPS = 10_000;
const V1_CAPACITY_RPS = 8_000;
const V2_CAPACITY_RPS = 6_000;

const params = [
  {
    id: "broadPriority",
    label: "Broad /api/* rule priority (sandbox 1–100)",
    min: 1,
    max: 100,
    step: 1,
    value: 20,
    unit: "",
    group: "Rules",
    help: "Priority of the rule that forwards every /api/* request to the v1 service. Lower numbers are evaluated first. AWS allows 1–50,000; this sandbox narrows the range to make the list readable.",
    format: "count" as const,
  },
  {
    id: "specificPriority",
    label: "Specific /api/v2/* rule priority (sandbox 1–100)",
    min: 1,
    max: 100,
    step: 1,
    value: 10,
    unit: "",
    group: "Rules",
    help: "Priority of the rule that should send /api/v2/* to the v2 service. It only runs if no earlier rule matches. AWS allows 1–50,000; this sandbox narrows the range.",
    format: "count" as const,
  },
  {
    id: "specificRulePresent",
    label: "Specific rule deployed (0 no, 1 yes)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Rules",
    help: "0 removes the /api/v2/* rule entirely. The broad rule then captures both v2 and v1 API traffic.",
    format: "count" as const,
  },
  {
    id: "apiV2Share",
    label: "API v2 share of traffic",
    min: 10,
    max: 60,
    step: 5,
    value: 40,
    unit: "%",
    group: "Traffic",
    help: "Share of all requests that are destined for /api/v2/*. The rest go to /api/* on the v1 service.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface State {
  broad: number;
  specific: number;
  present: boolean;
  share: number;
  apiV2Rps: number;
  otherRps: number;
  specificWins: boolean;
  shadowed: boolean;
  conflict: boolean;
  v1Rps: number;
  v2Rps: number;
  v1Served: number;
  v2Served: number;
  served: number;
  v1Load: number;
  v2Load: number;
  v2Idle: number;
  misrouted: number;
  errors: number;
  p99: number;
}

function compute(p: Params): State {
  const broad = Math.min(100, Math.max(1, Math.round(num(p, "broadPriority", 20))));
  const specific = Math.min(100, Math.max(1, Math.round(num(p, "specificPriority", 10))));
  const present = num(p, "specificRulePresent", 1) >= 0.5;
  const share = clamp(num(p, "apiV2Share", 40) / 100, 0, 1);
  const apiV2Rps = TOTAL_RPS * share;
  const otherRps = TOTAL_RPS - apiV2Rps;
  const conflict = present && broad === specific;
  const specificWins = present && !conflict && specific < broad;
  const shadowed = present ? !specificWins : true;
  const v1Rps = specificWins ? otherRps : TOTAL_RPS;
  const v2Rps = specificWins ? apiV2Rps : 0;
  const v1Served = Math.min(v1Rps, V1_CAPACITY_RPS);
  const v2Served = Math.min(v2Rps, V2_CAPACITY_RPS);
  const served = v1Served + v2Served;
  const v1Load = clamp((v1Rps / V1_CAPACITY_RPS) * 100, 0, 100);
  const v2Load = clamp((v2Rps / V2_CAPACITY_RPS) * 100, 0, 100);
  const v2Idle = clamp(((V2_CAPACITY_RPS - v2Rps) / V2_CAPACITY_RPS) * 100, 0, 100);
  const misrouted = specificWins ? 0 : share * 100;
  const v1Over = Math.max(0, v1Rps - V1_CAPACITY_RPS);
  const v2Over = Math.max(0, v2Rps - V2_CAPACITY_RPS);
  const errors = clamp(((v1Over + v2Over) / TOTAL_RPS) * 100, 0, 100);
  const queueing = v1Load > 85 ? (v1Load - 85) * 5 : 0;
  const p99 = Math.min(5_000, 12 + queueing + misrouted * 0.4);
  return {
    broad,
    specific,
    present,
    share,
    apiV2Rps,
    otherRps,
    specificWins,
    shadowed,
    conflict,
    v1Rps,
    v2Rps,
    v1Served,
    v2Served,
    served,
    v1Load,
    v2Load,
    v2Idle,
    misrouted,
    errors,
    p99,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, seed: number): SimFrame {
  const s = compute(p);
  const clientHealth: Health = s.misrouted >= 5 || s.errors >= 5 ? "crit" : s.misrouted > 0 || s.errors > 0 ? "warn" : "ok";
  const albHealth: Health =
    s.conflict || s.misrouted >= 5 || s.errors >= 5
      ? "crit"
      : s.misrouted > 0 || s.v1Load >= 85
        ? "warn"
        : "ok";
  const v1Health: Health = s.v1Load >= 95 ? "crit" : s.v1Load >= 85 ? "warn" : "ok";
  const v2Health: Health = s.v2Rps === 0 ? "ok" : s.v2Load >= 95 ? "crit" : s.v2Load >= 85 ? "warn" : "ok";
  const ruleLayout = s.present
    ? `rules ${s.specific} then ${s.broad}`
    : `broad only · specific rule absent`;
  const albDetail = s.present
    ? `Rules run from the lowest priority number upward. The /api/v2/* rule is at ${s.specific}; the /api/* rule is at ${s.broad}. The default rule runs last.`
    : `The /api/v2/* rule is not deployed. The /api/* rule at priority ${s.broad} forwards all API traffic to v1; the default rule runs last.`;
  const v2Detail = !s.present
    ? `The /api/v2/* rule is not deployed, so v2 receives no traffic. Its illustrative capacity is ${formatCount(V2_CAPACITY_RPS)} rps.`
    : s.conflict
      ? "The specific rule shares a priority with the broad rule and cannot be evaluated as configured. Assign a unique priority."
      : s.specificWins
        ? "The specific rule matches before the broad rule; v2 receives the API v2 share."
        : "The specific rule never runs because the broad rule has a lower number and matches first.";
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: TOTAL_RPS,
        sublabel: `${s.misrouted.toFixed(0)}% misrouted`,
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "ALB listener",
        kind: "lb",
        health: albHealth,
        throughput: s.served,
        sublabel: ruleLayout,
        detail: albDetail,
        meta: { view: "flow" },
      },
      {
        id: "v1",
        label: "v1 service",
        kind: "service",
        health: v1Health,
        utilization: clamp(s.v1Load / 100),
        throughput: s.v1Served,
        sublabel: `${formatCount(s.v1Rps)} rps · ${s.v1Load.toFixed(0)}%`,
        detail: `Target group for /api/*. Illustrative capacity is ${formatCount(V1_CAPACITY_RPS)} rps. It receives ${s.specificWins ? "non-v2 requests only" : "all requests, including /api/v2/*"}.`,
        meta: { view: "flow" },
      },
      {
        id: "v2",
        label: "v2 service",
        kind: "service",
        health: v2Health,
        utilization: clamp(s.v2Load / 100),
        throughput: s.v2Served,
        sublabel: s.v2Rps === 0 ? `0 rps · idle` : `${formatCount(s.v2Rps)} rps · ${s.v2Load.toFixed(0)}%`,
        detail: v2Detail,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-alb", "client", "alb", 1, clientHealth),
      edge("alb-v1", "alb", "v1", s.v1Served / TOTAL_RPS, v1Health),
      edge("alb-v2", "alb", "v2", s.v2Served / TOTAL_RPS, v2Health),
    ],
    metrics: [
      metric("misrouted", "Misrouted requests", s.misrouted, "%", 1, 5, "percent"),
      metric("v1-load", "v1 target utilization", s.v1Load, "%", 85, 95, "percent"),
      metric("v2-load", "v2 target utilization", s.v2Load, "%", 85, 95, "percent"),
      metric("v2-idle", "v2 capacity unused", s.v2Idle, "%", 50, 80, "percent"),
      metric("overload-5xx", "Capacity failures", s.errors, "%", 0.5, 5, "percent"),
      metric("priority-conflict", "Priority conflict", s.conflict ? 1 : 0, "", 1, 1, "count"),
      metric("rule-order", "Broad rule priority", s.broad, "", undefined, undefined, "count"),
      metric("p99", "End-to-end p99", s.p99, "ms", 100, 500, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      broad: s.broad,
      specific: s.specific,
      present: s.present ? 1 : 0,
      conflict: s.conflict ? 1 : 0,
    },
    summary: `${s.present ? `Rules ${s.specific} then ${s.broad}` : `Broad rule only at ${s.broad}`}: ${s.misrouted.toFixed(0)}% misrouted; v1 ${s.v1Load.toFixed(0)}%, v2 ${s.v2Load.toFixed(0)}%; ${s.errors.toFixed(0)}% capacity failures.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const value =
        item.value * (0.97 + 0.05 * Math.sin((index + (seed % 7)) / 2.3)) +
        Math.sin(index / 2.1) * amplitude;
      const bounded = item.format === "percent" ? Math.min(100, value) : value;
      return Math.max(0, bounded);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "misrouted",
    metricId: "misrouted",
    warn: 1,
    crit: 5,
    title: "A broad rule is capturing traffic for a specific rule",
    cause:
      "ALB listener rules are evaluated in priority order from the lowest number to the highest. A broad /api/* rule with a lower number matches /api/v2/* first, so the specific rule is never evaluated; if the specific rule was never deployed, the broad rule captures the traffic as well. Specificity is not a tiebreaker.",
    fix:
      "Move the specific rule to a lower priority number than the broad rule. Keep priorities unique, leave gaps for future rules, and put the default rule last.",
    checkFirst: [
      "Run describe-rules and sort by priority; confirm the specific rule is evaluated before the broad one.",
      "Read access logs for the target group chosen for /api/v2/* requests.",
      "Compare target group request counts; a starved specific target group is the clue.",
    ],
  },
  {
    id: "v1-load",
    metricId: "v1-load",
    warn: 85,
    crit: 95,
    title: "The broad target group is carrying traffic it should not see",
    cause:
      "The broad rule captured v2 traffic and sent it to the v1 target group. The extra load can overload v1 while v2 sits idle.",
    fix:
      "Fix the rule order before adding capacity. Adding targets to v1 hides the routing error and leaves v2 underused.",
    checkFirst: [
      "Compare v1 and v2 request counts with the expected API split.",
      "Check the target group chosen in the access log for a known v2 path.",
      "Confirm the rule conditions, not only the priority numbers.",
    ],
  },
  {
    id: "v2-load",
    metricId: "v2-load",
    warn: 85,
    crit: 95,
    title: "The specific target group is near capacity",
    cause:
      "The API split has grown or the v2 target group has too little capacity. This is a capacity limit, not a rule-order failure.",
    fix:
      "Add v2 targets or rebalance the API split. Verify the specific rule still matches before changing capacity.",
    checkFirst: [
      "Check v2 request count per target and target CPU.",
      "Confirm the expected v2 share with the application team.",
      "Check whether v1 has spare capacity for a temporary shift.",
    ],
  },
  {
    id: "v2-idle",
    metricId: "v2-idle",
    warn: 50,
    crit: 80,
    title: "The specific target group is starved",
    cause:
      "The specific rule is missing, has a higher priority number than the broad rule, or is otherwise not matching. The v2 target group receives little or no traffic.",
    fix:
      "Restore the specific rule and place it ahead of the broad rule. Verify the condition matches the real request host and path.",
    checkFirst: [
      "Check whether the specific rule exists and is attached to the listener.",
      "Compare its priority with the broad rule.",
      "Verify the host and path conditions against a real request.",
    ],
  },
  {
    id: "overload-5xx",
    metricId: "overload-5xx",
    warn: 0.5,
    crit: 5,
    title: "The misrouted traffic is causing real errors",
    cause:
      "The broad target group is above its capacity or the wrong service cannot serve the v2 request. Fixing the rule order is the first step; capacity is secondary.",
    fix:
      "Correct the priority order, then confirm v1 and v2 are within capacity. Check whether the wrong service returned a 4xx or 5xx for the v2 request.",
    checkFirst: [
      "Separate target-generated errors from load balancer errors.",
      "Check which target group received the failing request.",
      "Confirm the v2 service is healthy and has capacity.",
    ],
  },
  {
    id: "priority-conflict",
    metricId: "priority-conflict",
    warn: 1,
    crit: 1,
    title: "Two rules share the same priority",
    cause:
      "ALB listener rule priorities must be unique. A duplicate priority prevents the second rule from being created or updated, so the intended route may never exist.",
    fix:
      "Assign a unique priority to each rule. The valid range is 1 to 50,000; the default rule always evaluates last and its priority cannot be changed.",
    checkFirst: [
      "Run describe-rules and look for duplicate priority values.",
      "Check the last deployment or rule change for an API error.",
      "Confirm the intended rule exists before debugging its condition.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const albRulePriorityModel: SimModel = {
  id: "traffic-alb-rule-priority",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const s = compute(p);
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
    const noise = rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value * (1 + noise)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (s.shadowed && frame.flags.shadowed !== 1) {
      pushEvent(next, {
        id: "rule-shadowed",
        at: frame.t,
        severity: "crit",
        title: s.present ? "A broad rule is shadowing the specific route" : "The specific route is not deployed",
        detail: !s.present
          ? `The /api/v2/* rule does not exist. The /api/* rule at priority ${s.broad} captures all API traffic, so ${(s.share * 100).toFixed(0)}% of requests never reach v2.`
          : s.conflict
            ? "Two rules share a priority, so the intended rule cannot be evaluated as configured. Assign a unique priority."
            : `The /api/* rule at priority ${s.broad} is evaluated before the /api/v2/* rule at priority ${s.specific}. ${(s.share * 100).toFixed(0)}% of requests never reach v2.`,
        nodeId: "alb",
        metricId: "misrouted",
      });
      next.flags.shadowed = 1;
    } else if (!s.shadowed) {
      next.flags.shadowed = 0;
    }
    next.flags.broad = s.broad;
    next.flags.specific = s.specific;
    next.flags.present = s.present ? 1 : 0;
    next.flags.conflict = s.conflict ? 1 : 0;
    next.summary = `${s.present ? `Rules ${s.specific} then ${s.broad}` : `Broad rule only at ${s.broad}`}: ${s.misrouted.toFixed(0)}% misrouted; v1 ${s.v1Load.toFixed(0)}%, v2 ${s.v2Load.toFixed(0)}%; ${s.errors.toFixed(0)}% capacity failures.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const s = compute(p);
    const items: string[] = [];
    items.push(
      s.present
        ? `The listener evaluates /api/v2/* at priority ${s.specific} and /api/* at priority ${s.broad}.`
        : `The /api/v2/* rule is not deployed. The /api/* rule at priority ${s.broad} handles all API traffic.`,
    );
    items.push(
      !s.present
        ? `The broad rule sends ${s.misrouted.toFixed(0)}% of requests to v1 even though they belong to v2.`
        : s.specificWins
          ? "The specific rule wins because it has the lower number. The broad rule only sees the remaining requests."
          : `The broad rule wins because it has the lower number. ${s.misrouted.toFixed(0)}% of requests are sent to v1 even though they belong to v2.`,
    );
    items.push(`v1 carries ${formatCount(s.v1Rps)} rps at ${s.v1Load.toFixed(0)}%; v2 carries ${formatCount(s.v2Rps)} rps at ${s.v2Load.toFixed(0)}%.`);
    if (s.v2Idle >= 50) items.push(`${s.v2Idle.toFixed(0)}% of v2 capacity is unused while v1 absorbs the overflow.`);
    if (s.conflict) items.push("The two rules cannot share a priority; the second rule will not be created or updated as intended.");
    if (s.errors > 0) items.push(`${s.errors.toFixed(0)}% of requests fail at the overloaded target group.`);
    items.push("The default rule is evaluated last; it is a safety net, not a catch-all that should beat a real route.");
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
    label: "Specific first",
    description: "The /api/v2/* rule has priority 10 and runs before the /api/* rule at 20.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak API v2",
    description: "Correct rule order with a larger v2 share; v2 is near its warning line.",
    tone: "warn",
    params: defaults({ apiV2Share: 55 }),
  },
  {
    id: "failure",
    label: "Shadowed route",
    description: "The broad /api/* rule has priority 10; the specific /api/v2/* rule at 20 never runs.",
    tone: "crit",
    params: defaults({ broadPriority: 10, specificPriority: 20, specificRulePresent: 1, apiV2Share: 40 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The specific rule is restored ahead of the broad rule at a lower API v2 share.",
    tone: "ok",
    params: defaults({ broadPriority: 30, specificPriority: 5, specificRulePresent: 1, apiV2Share: 35 }),
  },
];

const experiment: Experiment = {
  id: "predict-first-match",
  title: "Predict which rule wins",
  simId: "alb-rule-priority",
  question:
    "A listener has /api/* at priority 10 and /api/v2/* at priority 20. A request for /api/v2/users arrives. Which rule handles it?",
  prediction: {
    options: [
      { id: "broad", label: "The /api/* rule, because priority 10 is evaluated first." },
      { id: "specific", label: "The /api/v2/* rule, because its condition is more specific." },
      { id: "default", label: "The default rule, because two rules match." },
      { id: "split", label: "The request is split between both target groups." },
    ],
    correctOptionId: "broad",
    explanation:
      "ALB listener rules are evaluated in priority order from the lowest numeric value to the highest, and the first matching rule wins. /api/v2/users matches both /api/* and /api/v2/*, but /api/* is evaluated first at priority 10. Specificity does not reorder the rules. The specific route works only after it is moved to a lower number than the broad rule.",
  },
  setup: defaults({ broadPriority: 10, specificPriority: 20, specificRulePresent: 1, apiV2Share: 40 }),
  runFor: 10,
  observe: [
    "Forty percent of requests are misrouted to v1 while v2 receives none.",
    "v1 runs at 100% of its illustrative capacity and fails 20% of requests.",
    "v2 capacity is completely unused even though the rule exists.",
    "The ALB rule list shows the broad rule ahead of the specific one.",
  ],
  explain:
    "The broad /api/* condition also matches /api/v2/*. Because it has the lower priority number, it consumes the request before the specific rule is considered. The v2 service is healthy and has capacity; it simply never receives the traffic. Adding v1 capacity would hide the symptom without fixing the routing.",
  fix: defaults({ broadPriority: 20, specificPriority: 10, specificRulePresent: 1, apiV2Share: 40 }),
  debrief:
    "Swapping the priorities lets the specific rule match first. v2 receives its 40% share, v1 falls back to 75% of capacity, and the misroute rate drops to zero. The rule set is deterministic; the order is the design decision.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Application Load Balancer (ALB) listener has rules. Each rule has a priority, one or more conditions, and an action. The ALB evaluates the rules from the lowest priority number to the highest and applies the first rule whose conditions match. The default rule is evaluated last, has no conditions, and cannot have its priority changed. A rule can match host, path, HTTP header, method, query string, or source IP; a rule can combine conditions, but the order is still the priority order.",
  },
  {
    type: "p",
    text: "Priority numbers are unique within a listener and range from 1 to 50,000. The default quota is 100 rules per ALB excluding the default rule, and that quota is adjustable. A more specific condition does not get special treatment. A broad /api/* rule at a lower number will consume /api/v2/* traffic before the specific rule is ever considered. That is the shadowing failure this module teaches.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, listener, ordered rule list, target group. The listener sees the request; the rule list decides which target group receives it; the target group chooses a healthy target. The default rule is the final fallback after every other rule has been evaluated. A rule that never matches is invisible in the target group metrics except as missing traffic and idle capacity.",
  },
  {
    type: "compare",
    leftTitle: "What engineers expect",
    rightTitle: "What the ALB does",
    rows: [
      { label: "Specificity", left: "The most specific condition wins", right: "The first matching rule wins" },
      { label: "Ordering", left: "Rules are sorted by condition depth", right: "Rules are sorted by numeric priority only" },
      { label: "Overlap", left: "The closest match is chosen", right: "The lowest-numbered match consumes the request" },
      { label: "Default", left: "A catch-all is a normal rule", right: "The default rule is last and cannot be reordered" },
    ],
  },
  {
    type: "p",
    text: "The practical rule is simple: put specific routes before broad routes, and put the default rule last. Leave gaps between priorities so a new rule can be inserted without renumbering the whole list. Test the deployed rule set, not only the rule you added, because the interaction with an existing broad rule is what usually breaks. The same ordering applies to host conditions: a broad wildcard host at a lower number can shadow a specific host. The ALB default rule is evaluated last and cannot shadow a specific rule; the shadow in this lab comes from a broad catch-all rule with a lower number. If the specific rule is missing, traffic can still fall through to the default action.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "The two rule priorities and which one the listener evaluates first.",
      "Misrouted request share and the v1/v2 target group utilization.",
      "Unused capacity in the starved target group and capacity failures in the overloaded one.",
      "A priority-conflict signal when two rules share a number.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with the specific rule at priority 10. Swap the numbers and watch the misroute rate jump to the API v2 share. Remove the specific rule and watch the same thing happen without a competing rule. Restore the order and confirm v2 receives traffic again.",
  },
  {
    type: "table",
    headers: ["Observation", "Likely rule cause", "First check"],
    rows: [
      ["v2 target group receives no traffic", "Specific rule shadowed or missing", "describe-rules order and condition match" ],
      ["v1 target group overloaded", "Broad rule captured v2 traffic", "Access log target group for a known v2 path" ],
      ["Rule works in staging, not production", "Different existing rule set or priorities", "Compare the full deployed rule list, not the new rule alone" ],
      ["Rule cannot be saved", "Duplicate priority or rule quota", "Check unique priorities and the rules-per-ALB quota" ],
    ],
  },
  { type: "sim", simId: "alb-rule-priority" },
  { type: "experiment", experimentId: "predict-first-match" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The /api/* rule at priority 10 matched every API request, including /api/v2/*. The specific rule at priority 20 was never evaluated, so the v2 target group received no traffic and the v1 target group absorbed the full request rate. v1 went above its capacity while v2 sat idle. Swapping the numbers restored the intended split.",
  },
  {
    type: "p",
    text: "The staging success was not a lie about the rule itself; it was a difference in the surrounding rule list. Production had a broad rule at a lower number. The rule condition and the target group were correct; the order was not.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ALB: `RuleEvaluations` rises when many rules are evaluated per request; a specific rule that never runs is invisible in that metric alone.",
      "Access logs: the chosen target group and the request path. A v2 path landing on the v1 target group is the direct evidence.",
      "Target groups: request count per target, target response time, and target-generated 4xx/5xx by target group.",
      "Configuration: `describe-rules` sorted by priority, including the default rule and every condition.",
      "Deployments: the rule change that added or renumbered a broad rule before the specific one.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the deployed rule list, sorted by priority, before you change the rule condition. If a broad rule has a lower number, the specific rule will not run. Then confirm the request actually matches the specific condition; a host or path typo produces the same starved target group.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "List every rule on the listener with its priority and conditions.",
      "Find the first rule that matches the request, not the rule you intended to match.",
      "Move the specific rule to a lower number than the broad rule.",
      "Keep priorities unique and leave gaps for future rules.",
      "Verify the default rule is still last and still does something safe.",
      "Replay a known request and confirm the target group in the access log.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A low-numbered broad rule is easy to add and easy to forget; it becomes a permanent shadow over every later specific rule.",
      "Many narrow rules improve routing precision but consume the rules-per-ALB quota and make the order harder to reason about.",
      "Host conditions are stable across path changes; path conditions are more granular but more likely to overlap.",
      "A default rule that returns a fixed response is safe but can hide a missing route; a default that forwards to a real service keeps traffic flowing but may send it to the wrong place.",
      "Regex conditions increase flexibility and review cost; wildcard conditions are simpler but can match more than intended.",
      "Renumbering rules to insert a specific route is a configuration change with production blast radius; leave priority gaps to avoid it.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "staging-vs-production-rule",
    question:
      "A new host rule works in staging but not production. The rule condition and target group are identical. What do you check?",
    difficulty: 2,
    hints: [
      "The rule is evaluated relative to every other rule.",
      "The lowest matching priority wins.",
    ],
    answer:
      "I would compare the full deployed rule list in both environments, sorted by priority. A broad rule in production may have a lower number than the new rule and match the same host or path first. I would replay a request and read the access log to see which target group actually received it. I would also check that the new rule exists on the production listener, that its priority is unique, and that the host or path condition matches the real request. The rule itself can be correct while the order makes it unreachable.",
    followUps: [
      "How would you prove a broad rule is the one matching?",
      "What would you change to prevent this class of bug?",
      "How do you test rule order before production?",
    ],
    redFlags: [
      "Only compares the new rule's condition.",
      "Assumes the more specific rule wins.",
      "Changes the target group before reading the rule list.",
    ],
    rubric: [
      "Compares the full rule list by priority.",
      "Uses access logs or target group traffic.",
      "Checks condition match and rule existence.",
      "Explains first-match behavior.",
    ],
  },
  {
    id: "design-rule-order",
    question:
      "How do you design an ALB listener rule order that stays maintainable as routes are added?",
    difficulty: 3,
    hints: [
      "Specific before broad; default last.",
      "Leave room to insert rules.",
    ],
    answer:
      "I would group rules by specificity: exact hosts and deep paths first, then broader host or path rules, then the default action. I would leave gaps in the priority numbers, for example 10, 20, 30, so a new specific rule can be inserted at 15 without renumbering. I would keep the default rule as a deliberate safe action, document the order, and test it with a request matrix that covers every host and path combination. I would also watch the rules-per-ALB quota and avoid regex or wildcard conditions that overlap more than intended.",
    followUps: [
      "What would you put in the default rule?",
      "How do you review a rule change for shadowing?",
      "When would you split listeners instead of adding rules?",
    ],
    redFlags: [
      "Relies on specificity instead of priority.",
      "Puts a catch-all at the top.",
      "Renumbers every rule for each addition.",
    ],
    rubric: [
      "Orders specific before broad.",
      "Leaves priority gaps.",
      "Keeps a deliberate default.",
      "Tests the full request matrix.",
    ],
  },
  {
    id: "rule-quota",
    question:
      "Your team keeps adding rules and is near the per-ALB limit. What are the options, and what would you check before requesting an increase?",
    difficulty: 3,
    hints: [
      "The default quota is 100 rules per ALB excluding the default.",
      "More rules also mean more evaluations and more overlap risk.",
    ],
    answer:
      "I would first inventory the rules and remove dead or duplicate conditions, then consolidate overlapping paths or hosts where the same target group is used. If the routes are genuinely distinct, I would check whether the quota can be increased or whether the services should move to separate ALBs or listeners. More rules increase evaluation work and the chance of shadowing, so I would not request an increase without a request matrix and an ownership plan. I would also check whether a default action or a path rewrite could replace several rules.",
    followUps: [
      "How would you detect a dead rule?",
      "When is a separate ALB cheaper than more rules?",
      "What does RuleEvaluations tell you?",
    ],
    redFlags: [
      "Requests an increase without cleaning up.",
      "Adds rules without an ownership model.",
      "Ignores the evaluation and overlap cost.",
    ],
    rubric: [
      "Inventories and consolidates first.",
      "Names the default quota and adjustable nature.",
      "Considers separate listeners or ALBs.",
      "Accounts for shadowing and evaluation cost.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The full listener rule list is reviewed by priority, not only by the newest rule.",
      "Specific routes have lower numbers than broad routes.",
      "Priorities are unique and leave gaps for insertion.",
      "The default rule has a deliberate, safe action.",
      "The rules-per-ALB quota and ownership are documented.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read describe-rules in priority order.",
      "Find the first matching rule for a known request.",
      "Check the target group in the access log.",
      "Compare target group request counts to the expected split.",
      "Do not add capacity before confirming the rule order.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Replay a request matrix covering every host and path.",
      "Remove dead or duplicate rules.",
      "Add a review check for shadowing when a broad rule is introduced.",
      "Record the priority layout and the reason for each gap.",
    ],
  },
];

const references = [
  {
    title: "Listener rules for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-rules.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Priority order, first match, the default rule, and rule components.",
  },
  {
    title: "Condition types for listener rules",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-condition-types.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Host, path, header, method, query, and source IP conditions, including wildcard behavior.",
  },
  {
    title: "CreateRule",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/APIReference/API_CreateRule.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Unique priority requirement and the valid 1–50,000 range.",
  },
  {
    title: "Quotas for your Application Load Balancers",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-limits.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Rules per ALB, condition values, wildcards, and match evaluations.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "alb-rule-priority": {
      model: albRulePriorityModel,
      presets,
      instructions:
        "Start specific-first. Swap the two priorities and watch v2 traffic disappear. Remove the specific rule and see the same starvation without a competing rule. Restore the order and verify both target groups receive their share.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Request rate, target capacities, and latency are teaching values, not AWS limits or guarantees. AWS documents first-match priority order, the unique 1–50,000 priority range, and the default rule; the exact target mix depends on the deployed rule set.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["traffic-alb-target-groups", "traffic-host-routing", "traffic-503-debug"],
};
