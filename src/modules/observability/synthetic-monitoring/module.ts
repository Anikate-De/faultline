import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  Params,
  ParamSpec,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_PROBES = 6;
const REGIONS = 8;
const SECONDS_PER_WEEK = 604_800;
const TRANSIENT_FLAKE = 0.005;
const USER_RPS = 800;

const params: ParamSpec[] = [
  {
    id: "probesInRegion",
    label: "Probes in the affected region",
    min: 0,
    max: 4,
    step: 1,
    value: 2,
    unit: " probes",
    group: "Coverage",
    help: "How many of the six probe locations run inside ap-south-1. A probe outside the region cannot see a regional edge failure.",
    format: "count",
  },
  {
    id: "interval",
    label: "Probe interval",
    min: 10,
    max: 300,
    step: 10,
    value: 60,
    unit: " s",
    group: "Schedule",
    help: "Time between checks from one location. Shorter intervals detect faster and raise check volume and flake pages.",
    format: "number",
  },
  {
    id: "confirmations",
    label: "Failures before alert",
    min: 1,
    max: 5,
    step: 1,
    value: 2,
    unit: " checks",
    group: "Schedule",
    help: "Consecutive failed checks required to page. More confirmations reduce false pages and add detection time for a total failure.",
    format: "count",
  },
  {
    id: "failureRate",
    label: "Regional failure rate",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Incident",
    help: "Share of requests that fail at the ap-south-1 edge. Probes outside the region still succeed, which is the blind spot.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  probesInRegion: number;
  interval: number;
  confirmations: number;
  failureRate: number;
  probeSuccess: number;
  detectionSeconds: number;
  userError: number;
  falsePages: number;
  checksPerWeek: number;
}

function compute(p: Params): Computed {
  const probesInRegion = Math.round(num(p, "probesInRegion", 2));
  const interval = Math.round(num(p, "interval", 60));
  const confirmations = Math.round(num(p, "confirmations", 2));
  const failureRate = num(p, "failureRate", 0);
  const probeSuccess = 100 - (probesInRegion / TOTAL_PROBES) * failureRate;
  const detectionSeconds =
    failureRate <= 0 ? 0 : probesInRegion <= 0 ? 3_600 : interval * confirmations;
  const userError = (failureRate / 100) * (100 / REGIONS);
  const checksPerWeek = (TOTAL_PROBES * SECONDS_PER_WEEK) / interval;
  return {
    probesInRegion,
    interval,
    confirmations,
    failureRate,
    probeSuccess,
    detectionSeconds,
    userError,
    falsePages: checksPerWeek * TRANSIENT_FLAKE ** confirmations,
    checksPerWeek,
  };
}

function edgeHealth(rate: number): Health {
  if (rate >= 80) return "crit";
  if (rate > 0) return "warn";
  return "ok";
}

function probeHealth(success: number): Health {
  if (success < 85) return "crit";
  if (success < 95) return "warn";
  return "ok";
}

function detectionLabel(seconds: number): string {
  return seconds >= 3_600 ? "user report only" : `${seconds}s`;
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metrics: [string, number, number][] = [
    ["detection-time", values.detectionSeconds, values.detectionSeconds * 0.02],
    ["probe-failure", 100 - values.probeSuccess, 0.4],
    ["user-error", values.userError, 0.1],
    ["false-pages", values.falsePages, Math.max(0.02, values.falsePages * 0.05)],
    ["checks-per-week", values.checksPerWeek / 1_000, (values.checksPerWeek / 1_000) * 0.01],
  ];
  for (const [id, value, amplitude] of metrics) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value + Math.sin((index + (seed % 6)) / 2.8) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const edge = edgeHealth(values.failureRate);
  const probe = probeHealth(values.probeSuccess);
  return {
    t: 0,
    nodes: [
      {
        id: "users",
        label: "Users, all regions",
        kind: "client",
        health: "ok",
        throughput: USER_RPS,
        sublabel: `${USER_RPS} req/s fleet`,
        meta: { view: "flow" },
      },
      {
        id: "probes",
        label: "Synthetic probes",
        kind: "external",
        health: probe,
        sublabel: `${values.probesInRegion}/${TOTAL_PROBES} in region`,
        detail: `${values.probesInRegion} of ${TOTAL_PROBES} probe locations run in ap-south-1. The other locations test a different network path.`,
        meta: { view: "flow" },
      },
      {
        id: "dns",
        label: "Regional DNS",
        kind: "dns",
        health: "ok",
        sublabel: `${USER_RPS} queries/s, resolves to edge`,
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "ap-south-1 edge",
        kind: "cdn",
        health: edge,
        throughput: USER_RPS,
        sublabel: values.failureRate > 0 ? `${values.failureRate}% failing` : "healthy",
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "Application",
        kind: "service",
        health: "ok",
        throughput: USER_RPS * (1 - values.userError / 100),
        sublabel: "servers healthy",
        meta: { view: "flow" },
      },
    ],
    edges: [
      { id: "users-dns", from: "users", to: "dns", rate: 0.99, health: "ok" },
      {
        id: "probes-dns",
        from: "probes",
        to: "dns",
        rate: clamp(TOTAL_PROBES / values.interval / USER_RPS, 0.001, 1),
        health: probe,
      },
      { id: "dns-edge", from: "dns", to: "edge", rate: 1, health: edge },
      {
        id: "edge-app",
        from: "edge",
        to: "app",
        rate: clamp(1 - values.userError / 100, 0, 1),
        health: edge,
      },
    ],
    metrics: [
      metric("detection-time", "Time to detect total failure", values.detectionSeconds, " s", 120, 300, "number"),
      metric("probe-failure", "Probe check failures", 100 - values.probeSuccess, "%", 5, 15, "percent"),
      metric("user-error", "Fleet-wide user errors", values.userError, "%", 1, 5, "percent"),
      metric("false-pages", "False pages", values.falsePages, " /week", 5, 20, "number"),
      metric("checks-per-week", "Probe checks", values.checksPerWeek / 1_000, "k checks/week", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, totalProbes: TOTAL_PROBES, regions: REGIONS },
    summary: `Detect in ${detectionLabel(values.detectionSeconds)}; probes ${values.probeSuccess.toFixed(1)}% successful; fleet errors ${values.userError.toFixed(1)}%; ${values.falsePages.toFixed(1)} false pages/week.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "detection-time",
    metricId: "detection-time",
    warn: 120,
    crit: 300,
    title: "Total regional failure detection depends on user reports",
    cause: "No probe runs inside the affected region. Checks from other locations resolve and connect through their own edge, so they pass while users in the failing region time out. The displayed time is the confirmation bound for a total failure; a partial failure takes longer.",
    fix: "Add a probe location, or a private or browser check, that enters through the same region and path. Then verify that a simulated total failure is detected in one confirmation window.",
    checkFirst: [
      "Map probe locations to the regions where users actually are.",
      "Check whether a green probe exercises the same DNS answer and edge as the failing users.",
      "Confirm the check asserts content, not only a TCP connection.",
    ],
  },
  {
    id: "probe-failure",
    metricId: "probe-failure",
    warn: 5,
    crit: 15,
    title: "Synthetic checks are failing from some locations",
    cause: "A regional edge, DNS answer, TLS certificate, or application response is failing for the path the probes exercise.",
    fix: "Split results by location and check stage, then compare a failing location with a passing one. Fix the regional dependency and re-run the check from both locations.",
    checkFirst: [
      "Split the result by probe location and check stage: DNS, TCP, TLS, HTTP.",
      "Compare the failing and passing locations at the same timestamp.",
      "Check whether the failure is an assertion, a timeout, or a certificate error.",
    ],
  },
  {
    id: "user-error",
    metricId: "user-error",
    warn: 1,
    crit: 5,
    title: "Fleet-wide user errors are rising",
    cause: "One regional edge is failing every request. Because the fleet spans eight regions, the fleet-wide error rate is the regional failure rate divided by eight; the regional rate is much worse than this number.",
    fix: "Treat the fleet error rate as the symptom and add regional probe coverage before changing the edge. Keep the probe path and the user path aligned.",
    checkFirst: [
      "Compare user errors by region with probe results by location.",
      "Check DNS answers returned to the affected region.",
      "Check whether the edge or an upstream dependency is regional.",
    ],
  },
  {
    id: "false-pages",
    metricId: "false-pages",
    warn: 5,
    crit: 20,
    title: "Probe flake is creating pages without user impact",
    cause: "A short interval with a single-confirmation alert turns transient network noise into pages. Each failed check is treated as an incident even when no user is affected.",
    fix: "Require two or three consecutive failures and keep the interval short enough to detect real failures. Alert on the confirmation window, not on one check.",
    checkFirst: [
      "Look for isolated failures surrounded by successful checks.",
      "Compare the page time with user error rate and latency.",
      "Check whether the probe location has known network instability.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const syntheticModel: SimModel = {
  id: "observability-synthetic-monitoring",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.005, 0.005);
    next.metrics = next.metrics.map((item) =>
      item.id === "checks-per-week" ? { ...item, value: Math.max(0, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.failureRate > 0 && values.probesInRegion === 0 && frame.flags.regionBlindSeen !== 1) {
      pushEvent(next, {
        id: "regional-failure-unseen",
        at: frame.t,
        severity: "warn",
        title: "Regional failure is invisible to every probe",
        detail: `All ${TOTAL_PROBES} probe locations pass, but none runs in ap-south-1. Detection waits for a user report while ${values.userError.toFixed(1)}% of all requests fail because one of ${REGIONS} regions is down.`,
        nodeId: "probes",
        metricId: "detection-time",
      });
      next.flags.regionBlindSeen = 1;
    }
    if (values.failureRate <= 0 || values.probesInRegion > 0) next.flags.regionBlindSeen = 0;
    next.summary = `Detect in ${detectionLabel(values.detectionSeconds)}; probes ${values.probeSuccess.toFixed(1)}% successful; fleet errors ${values.userError.toFixed(1)}%; ${values.falsePages.toFixed(1)} false pages/week.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `A check runs every ${values.interval}s and pages after ${values.confirmations} consecutive failures, so a total regional failure is detected in ${values.confirmations * values.interval}s.`,
      values.probesInRegion === 0
        ? `No probe runs in the failing region. Probe success is ${values.probeSuccess.toFixed(0)}% while ${values.userError.toFixed(1)}% of all requests fail because one region is down.`
        : `${values.probesInRegion} probe location${values.probesInRegion === 1 ? "" : "s"} sit in the region; probe success reflects ${values.probeSuccess.toFixed(1)}% of checks.`,
      `The six locations run ${Math.round(values.checksPerWeek).toLocaleString()} checks per week. At a 0.5% transient flake rate, ${values.falsePages.toFixed(1)} page${values.falsePages === 1 ? "" : "s"} per week are expected with ${values.confirmations} confirmation${values.confirmations === 1 ? "" : "s"}.`,
      `A green probe proves one location's path, not the whole edge. Coverage and interval are separate limits on detection.`,
      `The fleet-wide error rate is the regional rate divided by ${REGIONS}; it understates the region that is down.`,
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Partial", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Two probes in the region, a 60s interval, and two confirmations. No failure and low flake pages.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Partial regional failure",
    description: "A 20% failure in a region with two probes. Probe failures and fleet errors warn; the detection bound is for a total failure.",
    tone: "warn",
    params: defaults({ failureRate: 20 }),
  },
  {
    id: "failure",
    label: "Blind region",
    description: "The edge fails 100% in ap-south-1 and no probe runs there. Every probe stays green.",
    tone: "crit",
    params: defaults({ probesInRegion: 0, failureRate: 100 }),
  },
  {
    id: "covered",
    label: "Same failure, covered",
    description: "Two probes now enter through ap-south-1. Detection drops to 60s and probe success reflects the outage.",
    tone: "crit",
    params: defaults({ failureRate: 100, interval: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The edge is repaired and the coverage stays. Detection returns to zero and probe checks pass.",
    tone: "ok",
    params: defaults({ failureRate: 0, interval: 30 }),
  },
];

const experiment: Experiment = {
  id: "predict-probe-blindspot",
  title: "Predict what six green probes prove",
  simId: "synthetic-monitoring",
  question:
    "Six probes in six locations are green. Users in ap-south-1 report timeouts to the same hostname. Which conclusion is supported?",
  prediction: {
    options: [
      { id: "coverage-gap", label: "The probes do not exercise the failing region's path, so green does not cover it" },
      { id: "servers-healthy", label: "The application servers are healthy everywhere, so the users must be wrong" },
      { id: "dns-global", label: "Global DNS is broken because one region cannot resolve the hostname" },
      { id: "tls-only", label: "TLS must be failing for browsers but not for synthetic HTTP checks" },
    ],
    correctOptionId: "coverage-gap",
    explanation:
      "A synthetic check proves the path from its own location: the resolver it uses, the edge it reaches, and the response it receives. A regional edge failure changes the path for users in that region. If no probe enters through that edge, all probes can pass while those users fail.",
  },
  setup: defaults({ probesInRegion: 0, failureRate: 100 }),
  runFor: 20,
  observe: [
    "Probe success stays at 100% while 12.5% of all requests fail because one of eight regions is down.",
    "Time to detect is 3,600s, the user-report cap, because no probe covers the region.",
    "The edge node is critical and the probe node is healthy, which is the coverage gap in one view.",
    "False pages stay low; the problem is not noise, it is absence of evidence.",
  ],
  explain:
    "Detection time has two independent limits. The schedule sets how quickly a covered total failure is confirmed: interval times confirmations. Coverage sets whether any check sees the failure at all. Adding a probe in the region changes the second limit. It does not repair the edge, and it does not shorten the confirmation window.",
  fix: defaults({ probesInRegion: 2, failureRate: 100, interval: 30 }),
  debrief:
    "With two probes in ap-south-1 and a 30s interval, the same failure is detected in 60s and probe success falls to about 67%. The edge is still broken. What changed is that the system now knows before users call. The next fix is the regional edge itself, and the new probes become the verification that it recovered.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Synthetic monitoring runs scripted checks against a service on a schedule. A check can resolve DNS, open a TCP connection, complete a TLS handshake, send an HTTP request, and assert on the status, body, or timing. Browser checks extend this to rendering and script execution. The result is a pass or fail with timing for each stage, produced without waiting for a real user.",
  },
  {
    type: "p",
    text: "The value is outside-in evidence. Server CPU, request rate, and application logs can all look normal while a regional edge or a DNS answer is wrong for one group of users. A probe from the right location exercises the same path those users take. A probe from the wrong location exercises a different path and proves only that the different path works.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The probe sits outside your infrastructure and follows the user path inward: resolver, edge, load balancer, application, and any dependency the check touches. Each stage narrows the diagnosis. A DNS failure is not a TLS failure, and a TLS failure is not an application error. The location matters because DNS answers and edge routing can differ by region.",
  },
  {
    type: "table",
    headers: ["Check stage", "What it proves", "Typical failure"],
    rows: [
      ["DNS", "The name resolves from that resolver", "Wrong record, stale cache, regional resolver issue"],
      ["TCP", "A connection reaches the edge", "Route, firewall, or edge availability"],
      ["TLS", "The certificate chains and the handshake completes", "Expired certificate, SNI mismatch, protocol mismatch"],
      ["HTTP", "The response matches the assertion", "Application error, redirect, auth, bad content"],
    ],
  },
  {
    type: "p",
    text: "Two limits set detection time. Coverage decides whether a probe sees the failure at all. The schedule decides how fast a covered total failure is confirmed: the interval between checks times the number of consecutive failures required to alert. A partial failure takes longer, because each check must independently land in the failing share. This model assumes six locations, eight regions, and a 0.5% transient flake rate. Those are illustrative teaching values, not provider limits.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Time to detect a total failure: interval times confirmations, or a user-report cap when no probe covers the region.",
      "Probe success: the fleet-wide check pass rate, which can stay green while one region fails.",
      "Fleet-wide user errors: the regional failure divided by eight, which understates the region that is down.",
      "False pages per week: the cost of a short interval and too few confirmations.",
      "Probe checks per week: the volume that a shorter interval creates across all locations.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note both limits: two probes in the region and a 60s interval with two confirmations. Apply Blind region and watch probe success stay at 100% while time to detect hits the user-report cap. Then apply Same failure, covered and compare. Run the experiment before reading the debrief.",
  },
  { type: "sim", simId: "synthetic-monitoring" },
  { type: "experiment", experimentId: "predict-probe-blindspot" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The edge in ap-south-1 failed every request. The six probes passed because none of them entered through that edge. Probe success stayed at 100%, and detection time sat at the user-report cap of 3,600 seconds. The fleet-wide error rate was 12.5% because one of eight regions was fully down; a regional view would have shown 100%.",
  },
  {
    type: "p",
    text: "Adding two probes in the region and shortening the interval to 30 seconds changed both limits. Detection fell to 60 seconds because two confirmations at 30 seconds is one minute. Probe success fell to about 67%, which is the failure becoming visible. The edge was still broken. Detection is not repair, but it is the difference between learning from users and learning from telemetry.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Synthetic results split by location: a failing region next to passing regions at the same timestamp.",
      "Check-stage timings: DNS resolution, TCP connect, TLS handshake, time to first byte, and total duration.",
      "Assertion detail: expected and received status or body, not only a red dot.",
      "User telemetry: RUM or load balancer errors concentrated in one region while fleet metrics stay normal.",
      "Alert history: isolated failures that never repeat, which are flake rather than incidents.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Map probe locations to the regions where users are. Then compare a failing location with a passing one at the same time and split the result by DNS, TCP, TLS, and HTTP. If every probe passes, check coverage before you check the application.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Add a probe location that enters through the affected region, or use a private location inside the network.",
      "Keep the check on the real hostname and path, including DNS and TLS, rather than a direct IP health endpoint.",
      "Add an assertion for content or a critical API response so a 200 with an error page does not pass.",
      "Require consecutive failures to page, then measure the added detection time against the incident tolerance.",
      "Verify the fix by injecting a regional failure and confirming that the new probe fails within one window.",
      "Keep probe credentials and test data separate from production user data.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More locations improve coverage and multiply check volume and cost.",
      "A shorter interval detects faster and raises load, flake, and false pages unless confirmations rise too.",
      "More confirmations suppress noise and add interval times confirmations to detection.",
      "API checks are cheap and stable; browser checks catch rendering and script failures at higher cost.",
      "A passing probe is evidence about one path. Coverage must be designed, not assumed.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "green-probes",
    question:
      "All synthetic probes are green and users in one region report timeouts. How do you investigate without assuming the users are wrong?",
    difficulty: 2,
    hints: [
      "A probe tests its own path.",
      "Compare the failing region with a passing one.",
    ],
    answer:
      "I would treat the user reports as real and compare paths. First I would map where the probes run and whether any of them enter through the affected region. Then I would compare DNS answers, edge addresses, and TLS results from a failing user's region with a passing probe's region. If no probe covers the region, I would add one or run a one-off check from there. I would also check regional error rates and latency, because a fleet-wide average can hide a single-region failure.",
    followUps: [
      "What would you check if a probe in the region is also green?",
      "How would you test the user's exact path?",
      "What does a 200 response with an error page tell you?",
    ],
    redFlags: [
      "Closes the incident because probes are green.",
      "Assumes DNS is global.",
      "Ignores the regional error split.",
    ],
    rubric: [
      "Questions coverage.",
      "Compares regional paths.",
      "Adds a probe or one-off check.",
      "Checks user telemetry.",
    ],
  },
  {
    id: "detection-budget",
    question:
      "You need to detect a regional outage in under two minutes without flooding on-call. How do you set interval and confirmations?",
    difficulty: 3,
    hints: [
      "Detection is interval times confirmations for a total failure.",
      "False pages fall sharply with each extra confirmation.",
    ],
    answer:
      "If a total failure must be detected in under 120 seconds, I can use a 60-second interval with two confirmations, or 30 seconds with three. I would estimate flake pages from the check volume and the observed transient failure rate. With six locations and a one-minute interval, two confirmations already cut pages by orders of magnitude compared with one. I would alert on the confirmation window, split by location, and use a shorter interval only for the locations where the extra cost is justified.",
    followUps: [
      "What if the failure is partial and does not fail every check?",
      "How would you measure the transient flake rate?",
      "Would you use the same settings for browser checks?",
    ],
    redFlags: [
      "Picks one confirmation to detect fast.",
      "Ignores flake volume.",
      "Uses the same interval for every check type.",
    ],
    rubric: [
      "Uses interval × confirmations.",
      "Estimates false pages.",
      "Considers partial failure.",
      "Scopes settings by check type.",
    ],
  },
  {
    id: "probe-design",
    question:
      "Design a synthetic check for a checkout flow. What does it assert, where does it run, and what does it not cover?",
    difficulty: 3,
    hints: [
      "A health endpoint is not a user path.",
      "Authentication and test data are part of the design.",
    ],
    answer:
      "I would run an API or browser check from locations that match the main user regions, using the real hostname and TLS path. It would authenticate with a test account, add an item, start checkout, and assert on a known response or page element. I would record stage timings so a DNS or TLS failure is distinguishable from a slow application. It would not cover every payment method or every user segment, and it would not prove that real cards work. Those need separate checks and production monitoring.",
    followUps: [
      "How do you keep test data from polluting analytics?",
      "What would you assert in a browser check that an API check misses?",
      "How do you handle a third-party payment dependency?",
    ],
    redFlags: [
      "Checks only a static health endpoint.",
      "Uses a production user account.",
      "Claims the check covers all payment paths.",
    ],
    rubric: [
      "Uses the real path and hostname.",
      "Asserts content or a business outcome.",
      "Names location coverage.",
      "States what is not covered.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Probe locations match the regions where users actually are.",
      "Checks use the real hostname, TLS, and user path, not a direct IP health endpoint.",
      "Each check asserts a business-relevant response, not only a TCP connection.",
      "Interval and confirmations are chosen together against a detection target.",
      "Test accounts, credentials, and data are isolated from production users.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare probe results by location before concluding the service is healthy.",
      "Split failures by DNS, TCP, TLS, and HTTP stage.",
      "Compare a failing location with a passing one at the same timestamp.",
      "Check user telemetry by region to confirm the probe's blind spot.",
      "Add a temporary probe or one-off check from the affected region.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add permanent coverage for the region that was blind.",
      "Verify detection time with an injected regional failure.",
      "Tune confirmations against measured flake, not guesswork.",
      "Remove temporary checks and rotate test credentials.",
      "Document which paths each check does and does not cover.",
    ],
  },
];

const references = [
  {
    title: "Synthetic Monitoring",
    url: "https://docs.datadoghq.com/synthetics/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "API, browser, and network checks; locations; assertions; and alerting.",
  },
  {
    title: "Synthetic Monitoring",
    url: "https://grafana.com/docs/grafana-cloud/testing/synthetic-monitoring/",
    publisher: "Grafana Labs",
    kind: "docs" as const,
    note: "Probe locations, check types, and alert configuration for external and private probes.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "synthetic-monitoring": {
      model: syntheticModel,
      presets,
      instructions:
        "Start Healthy, then apply Blind region. Watch time to detect and user errors while probe success stays at 100%. Compare with Same failure, covered.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Six probe locations, eight regions, and the 0.5% flake rate are teaching values, not provider limits. Detection time is the interval × confirmations bound for a total regional failure; a partial failure takes longer.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-tls-handshake",
    "observability-golden-signals",
    "observability-slo-burn-rate",
    "observability-rum-web-vitals",
  ],
};
