import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "endpointHealthy",
    label: "Request path healthy (0 fail, 1 healthy)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Failure",
    help: "1 leaves the dependency and the request path healthy. 0 injects a dependency failure that affects the real user path.",
    format: "count",
  },
  {
    id: "checkDepth",
    label: "Check depth (0 shallow, 1 dependency-aware)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Health check",
    help: "0 probes a shallow /healthz that returns 200 without checking dependencies. 1 probes /ready, which fails when the dependency is unavailable.",
    format: "count",
  },
  {
    id: "failureThreshold",
    label: "Failure threshold",
    min: 1,
    max: 5,
    step: 1,
    value: 2,
    unit: " checks",
    group: "Health check",
    help: "Consecutive failed checks before a checker reports the endpoint unhealthy. Route 53 aggregates independent checker locations; this model uses interval times threshold as an illustrative detection time.",
    format: "count",
  },
  {
    id: "checkInterval",
    label: "Check interval (10 or 30)",
    min: 10,
    max: 30,
    step: 20,
    value: 10,
    unit: " s",
    group: "Health check",
    help: "Route 53 supports a 10-second or 30-second interval for endpoint checks. Values at or below 15 use 10 seconds in this model; larger values use 30.",
    format: "number",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  healthy: boolean;
  deep: boolean;
  threshold: number;
  interval: number;
  detectSeconds: number;
  elapsed: number;
  detected: boolean;
  checkPass: boolean;
  primaryShare: number;
  failedPercent: number;
  undetected: number;
  detectionMetric: number;
  secondaryUtil: number;
}

function compute(p: Params, t: number, incidentStart: number): Computed {
  const healthy = num(p, "endpointHealthy", 1) >= 0.5;
  const deep = num(p, "checkDepth", 1) >= 0.5;
  const threshold = Math.round(Math.min(5, Math.max(1, num(p, "failureThreshold", 2))));
  const interval = num(p, "checkInterval", 10) <= 15 ? 10 : 30;
  const detectSeconds = interval * threshold;
  const elapsed = healthy ? 0 : Math.max(0, t - incidentStart);
  const detected = !healthy && deep && elapsed >= detectSeconds;
  const checkPass = healthy || !deep || !detected;
  const primaryShare = healthy ? 100 : detected ? 0 : 100;
  const failedPercent = healthy ? 0 : primaryShare;
  const undetected = !healthy && !deep ? 100 : 0;
  return {
    healthy,
    deep,
    threshold,
    interval,
    detectSeconds,
    elapsed,
    detected,
    checkPass,
    primaryShare,
    failedPercent,
    undetected,
    detectionMetric: healthy || !deep ? 0 : detectSeconds,
    secondaryUtil: (1 - primaryShare / 100) * 50,
  };
}

function buildFrame(p: Params, t: number, incidentStart: number, seed: number): SimFrame {
  const c = compute(p, t, incidentStart);
  const clientHealth: Health = c.failedPercent > 5 ? "crit" : c.failedPercent > 1 ? "warn" : "ok";
  const checkerHealth: Health = c.checkPass ? "ok" : "crit";
  return {
    t,
    nodes: [
      {
        id: "clients",
        label: "Users",
        kind: "client",
        health: clientHealth,
        sublabel: c.failedPercent > 0 ? `${c.failedPercent.toFixed(0)}% failing requests` : "requests succeed",
        detail:
          "Users exercise the full request path. A health check that only proves the process is alive can stay green while these requests fail.",
        meta: { view: "flow" },
      },
      {
        id: "checker",
        label: "Route 53 health check",
        kind: "dns",
        health: checkerHealth,
        utilization: c.checkPass ? 0.1 : 0.9,
        sublabel: `${c.deep ? "/ready" : "/healthz"} · ${c.interval}s × ${c.threshold}`,
        detail: c.deep
          ? `The check probes the dependency-aware path. Illustrative detection time is ${c.detectSeconds}s. Route 53 aggregates independent checker locations and considers the endpoint healthy when more than 18% report healthy.`
          : "The check probes a shallow path that returns 200 even when the dependency is down. Route 53 is reporting what it observes; the observation does not cover the failing request path.",
        meta: { view: "flow" },
      },
      {
        id: "primary",
        label: "Primary endpoint",
        kind: "service",
        health: c.healthy ? "ok" : "down",
        utilization: c.healthy ? 0.45 : 0,
        sublabel: c.healthy ? "serving" : "request path failing",
        detail: c.healthy
          ? "The endpoint and its dependency are available."
          : "The endpoint is reachable but its dependency is unavailable. A shallow check can still return 200; a dependency-aware check returns a failure status.",
        meta: { view: "flow" },
      },
      {
        id: "dependency",
        label: "Dependency",
        kind: "external",
        health: c.healthy ? "ok" : "down",
        sublabel: c.healthy ? "available" : "unavailable",
        detail: "The dependency is the reason the request path fails. It is not necessarily the thing the health check probes.",
        meta: { view: "flow" },
      },
      {
        id: "secondary",
        label: "Secondary region",
        kind: "service",
        health: "ok",
        utilization: clamp(c.secondaryUtil / 100),
        sublabel: c.primaryShare === 100 ? "idle" : "receiving traffic",
        detail: "The secondary receives traffic only after Route 53 marks the primary unhealthy and clients refresh their answers.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-checker", "clients", "checker", 1, clientHealth),
      edge("checker-primary", "checker", "primary", c.primaryShare / 100, c.checkPass ? "ok" : "crit"),
      edge("primary-dependency", "primary", "dependency", c.healthy ? 1 : 0.2, c.healthy ? "ok" : "down"),
      edge("checker-secondary", "checker", "secondary", 1 - c.primaryShare / 100, "ok"),
    ],
    metrics: [
      metric("failed-requests", "Failing user requests", c.failedPercent, "%", 1, 5, "percent"),
      metric("undetected-failure", "Failure invisible to the check", c.undetected, "%", 1, 50, "percent"),
      metric("detection-seconds", "Detection time when visible", c.detectionMetric, " s", 30, 60, "number"),
      metric("check-pass", "Health check pass rate", c.checkPass ? 100 : 0, "%", undefined, undefined, "percent"),
      metric("traffic-primary", "Traffic to primary", c.primaryShare, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: c.healthy
      ? `Request path healthy. ${c.deep ? "Dependency-aware" : "Shallow"} check every ${c.interval}s with a ${c.threshold}-check threshold.`
      : `${c.failedPercent.toFixed(0)}% of user requests fail. The health check is ${c.checkPass ? "green" : "red"}${c.undetected > 0 ? "; the failure is invisible to it" : ""}.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "failed-requests",
    metricId: "failed-requests",
    warn: 1,
    crit: 5,
    title: "User requests are failing while the check may be green",
    cause:
      "The health check probes a path, port, or protocol that is not the failing request path. A process can accept a TCP connection or return 200 from a static health endpoint while its dependency is unavailable.",
    fix:
      "Probe a dependency-aware readiness path that performs the critical work the user needs. If the resource is private, use a CloudWatch alarm health check or a calculated check instead of a public endpoint probe.",
    checkFirst: [
      "Read the exact path, port, protocol, and expected status of the health check.",
      "Compare the health-check response body with a real user request.",
      "Check whether the failing dependency is exercised by the check.",
    ],
  },
  {
    id: "undetected-failure",
    metricId: "undetected-failure",
    warn: 1,
    crit: 50,
    title: "The health check cannot see this failure",
    cause:
      "The check is shallow or measures a proxy signal that stays healthy. Route 53 only fails over on the signal it receives; it has no independent view of the user request path.",
    fix:
      "Replace the shallow check with a deep readiness check, add a calculated check over the components that matter, or back the check with a CloudWatch alarm on real request success and latency.",
    checkFirst: [
      "Confirm whether the check is an endpoint check, a calculated check, or a CloudWatch alarm check.",
      "For a calculated check, read how many child checks must be healthy.",
      "For a CloudWatch-backed check, read the metric and statistic, not only the alarm name.",
    ],
  },
  {
    id: "detection-seconds",
    metricId: "detection-seconds",
    warn: 30,
    crit: 60,
    title: "Health-check detection is slower than the failover objective",
    cause:
      "Detection is bounded by the check interval and the failure threshold. A 30-second interval with five failed checks needs about 150 seconds before a checker reports unhealthy, before DNS caches expire.",
    fix:
      "Use the 10-second interval and the lowest failure threshold that does not produce false failovers. Test the threshold against real transient failures, then measure the full path including DNS TTL.",
    checkFirst: [
      "Compare the interval and failure threshold with the recovery objective.",
      "Check whether the failure is visible from multiple checker locations.",
      "Remember that DNS caching adds time after the check flips.",
    ],
  },
];

export const route53HealthChecksModel: SimModel = {
  id: "traffic-route53-health-checks",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, 0, seed);
    for (const item of frame.metrics) frame.series[item.id] = [item.value];
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.flags.paramsKey !== key;
    const incidentStart = reset ? frame.t : Number(frame.flags.incidentStart ?? 0);
    const t = frame.t + dt;
    const c = compute(p, t, incidentStart);
    const next = buildFrame(p, t, incidentStart, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([id, values]) => [id, [...values]]));
    next.events = [...frame.events].slice(-60);
    next.flags = reset
      ? { ...next.flags, paramsKey: key, incidentStart, failureLogged: 0, blindLogged: 0, flipLogged: 0 }
      : { ...frame.flags, ...next.flags, paramsKey: key, incidentStart };
    if (!c.healthy && frame.flags.failureLogged !== 1) {
      pushEvent(next, {
        id: "request-path-failing",
        severity: "crit",
        title: "The request path is failing",
        detail: "A dependency is unavailable. The health check result depends on whether its probe exercises that dependency.",
        nodeId: "primary",
        metricId: "failed-requests",
      });
      next.flags.failureLogged = 1;
      next.flags.flipLogged = 0;
    }
    if (c.undetected > 0 && frame.flags.blindLogged !== 1) {
      pushEvent(next, {
        id: "check-blind",
        severity: "crit",
        title: "Health check cannot see the failure",
        detail: `The check probes ${c.deep ? "a dependency-aware path" : "a shallow /healthz"} and reports healthy while ${c.failedPercent.toFixed(0)}% of user requests fail.`,
        nodeId: "checker",
        metricId: "undetected-failure",
      });
      next.flags.blindLogged = 1;
    }
    if (c.detected && frame.flags.flipLogged !== 1) {
      pushEvent(next, {
        id: "check-flipped",
        severity: "warn",
        title: "Health check marked the primary unhealthy",
        detail: `Detection took about ${c.detectSeconds}s with a ${c.interval}s interval and a ${c.threshold}-check threshold. DNS caches still need to expire before every client moves.`,
        nodeId: "checker",
        metricId: "detection-seconds",
      });
      next.flags.flipLogged = 1;
    }
    if (c.healthy && frame.flags.failureLogged === 1) {
      pushEvent(next, {
        id: "request-path-restored",
        severity: "info",
        title: "Request path restored",
        detail: "The dependency is available again. The health check returns to healthy on its next successful interval.",
        nodeId: "primary",
      });
      next.flags.failureLogged = 0;
      next.flags.blindLogged = 0;
      next.flags.flipLogged = 0;
    }
    const noise = rng.between(-0.003, 0.003);
    next.metrics = next.metrics.map((item) => {
      if (item.id === "failed-requests" && item.value > 0) {
        return { ...item, value: clamp(item.value + noise * 100, 0, 100) };
      }
      if (item.id === "traffic-primary" && item.value > 0) {
        return { ...item, value: clamp(item.value + noise * 100, 0, 100) };
      }
      return item;
    });
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const incidentStart = Number(frame.flags.incidentStart ?? 0);
    const c = compute(p, frame.t, incidentStart);
    const items: string[] = [];
    items.push(
      c.deep
        ? `The check probes a dependency-aware readiness path. With a ${c.interval}s interval and a ${c.threshold}-check threshold, illustrative detection is ${c.detectSeconds}s.`
        : "The check probes a shallow path that can return 200 while the dependency is down. Route 53 will keep the endpoint healthy.",
    );
    items.push(
      "Route 53 runs endpoint checks from multiple independent locations. It considers the endpoint healthy when more than 18% of checker locations report healthy, so a local network problem does not always force a failover.",
    );
    items.push(
      c.healthy
        ? "No failure is injected. Toggle the request path to see whether the check observes it."
        : c.detected
          ? `The check flipped after about ${c.detectSeconds}s. Traffic moves only after clients refresh their DNS answers; the TTL is covered in the prerequisite module.`
          : `The check has not flipped. ${c.undetected > 0 ? "It cannot see this failure." : "Detection time has not elapsed yet."}`,
    );
    if (!c.deep) {
      items.push("A TCP check or a static HTTP 200 is a liveness signal, not proof that the user request path works.");
    }
    items.push(
      "Calculated checks combine child checks with a quorum; CloudWatch-backed checks follow a metric data stream, not the alarm's display state.",
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
    description: "A dependency-aware check every 10s with a two-failure threshold.",
    tone: "ok",
    params: defaults({ endpointHealthy: 1, checkDepth: 1, failureThreshold: 2, checkInterval: 10 }),
  },
  {
    id: "peak",
    label: "Green but shallow",
    description: "The request path is healthy, but the check is shallow and slow. It would not see a dependency failure.",
    tone: "warn",
    params: defaults({ endpointHealthy: 1, checkDepth: 0, failureThreshold: 5, checkInterval: 30 }),
  },
  {
    id: "failure",
    label: "Green while broken",
    description: "The dependency fails, but the shallow /healthz check keeps returning 200. Route 53 never fails over.",
    tone: "crit",
    params: defaults({ endpointHealthy: 0, checkDepth: 0, failureThreshold: 3, checkInterval: 30 }),
  },
  {
    id: "slow-check",
    label: "Slow detection",
    description: "The check is deep but 30s × 5 checks takes 150s to detect the failure.",
    tone: "crit",
    params: defaults({ endpointHealthy: 0, checkDepth: 1, failureThreshold: 5, checkInterval: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The dependency is healthy again with a fast, dependency-aware check.",
    tone: "ok",
    params: defaults({ endpointHealthy: 1, checkDepth: 1, failureThreshold: 2, checkInterval: 10 }),
  },
];

const experiment: Experiment = {
  id: "predict-green-check",
  title: "Predict what the green check is measuring",
  simId: "route53-health-checks",
  question:
    "The checkout path returns errors, but Route 53 reports the primary endpoint healthy. What is the check most likely observing?",
  prediction: {
    options: [
      { id: "shallow", label: "A shallow /healthz endpoint that returns 200 without testing the dependency." },
      { id: "deep", label: "A dependency-aware /ready endpoint that exercises checkout." },
      { id: "dns", label: "Route 53 is caching the old health status because of the record TTL." },
      { id: "capacity", label: "The endpoint is healthy but the secondary region is at capacity." },
    ],
    correctOptionId: "shallow",
    explanation:
      "Route 53 only knows what the probe returns. A static health endpoint or a TCP connect can succeed while the dependency used by checkout is unavailable. The check is not lying; it is answering a narrower question than the one users are asking.",
  },
  setup: defaults({ endpointHealthy: 0, checkDepth: 0, failureThreshold: 3, checkInterval: 30 }),
  runFor: 30,
  observe: [
    "The health check pass rate stays at 100% while every user request fails.",
    "The failure invisible to the check metric is 100%.",
    "The primary endpoint is marked down by the dependency, but the checker stays green.",
    "Route 53 keeps returning the primary because its signal never changes.",
  ],
  explain:
    "A health check is a measurement, not a guarantee. This check connects to /healthz, which returns 200 as long as the web process is running. The dependency is a separate hop that the probe never touches. Route 53 aggregates the checker results and keeps the endpoint healthy, so failover never starts. A deep readiness check or a calculated check over the real dependencies would change the signal.",
  fix: defaults({ endpointHealthy: 1, checkDepth: 1, failureThreshold: 2, checkInterval: 10 }),
  debrief:
    "With a dependency-aware check every 10s and a two-check threshold, detection takes about 20s when the dependency fails. The tradeoff is that a deep check can fail during a dependency blip and remove a healthy endpoint. Choose the signal that matches the user path, then tune the threshold against real failure patterns.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Route 53 health check is a remote probe. For an endpoint check, Route 53 sends requests from health checker locations around the world to an IP address or domain name, using HTTP, HTTPS, or TCP. An HTTP or HTTPS check must connect within four seconds and return a 2xx or 3xx status within two seconds after connecting. A TCP check must connect within ten seconds. HTTPS checks do not validate the certificate.",
  },
  {
    type: "p",
    text: "The failure threshold is the number of consecutive failed checks a checker needs before it reports unhealthy. Route 53 aggregates the independent locations: if more than 18% report healthy, the endpoint is considered healthy. That rule prevents a network path from one region from causing a false failover. Route 53 also supports calculated checks, which combine child checks with a quorum, and CloudWatch-backed checks, which follow a metric data stream.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The health check sits beside the DNS record, not inside the request path. Route 53 uses the check result to decide whether to include a record in an answer. It does not repair the endpoint, and it cannot see a failure that the probe does not exercise. The probe path, port, protocol, and expected response are the contract.",
  },
  {
    type: "table",
    headers: ["Check type", "What it observes", "Best use"],
    rows: [
      ["Endpoint", "HTTP status, response body string, or TCP connect from public checkers", "A public readiness endpoint that exercises the critical path"],
      ["Calculated", "How many child health checks are healthy", "A fleet or a multi-component service with a quorum requirement"],
      ["CloudWatch alarm", "A CloudWatch metric data stream", "Private resources or signals a public probe cannot reach"],
    ],
  },
  {
    type: "p",
    text: "The check interval is 10 or 30 seconds. Faster checks shorten detection and can add optional-feature cost; more checker locations improve confidence that a local network problem is not treated as a service failure. The failure threshold is the other half of the budget. Detection is roughly interval times threshold per checker, though the real result also depends on how many locations observe the failure and on the 18% aggregation rule.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A request path that fails while the health check stays green.",
      "A checker that flips after its interval and failure threshold, with the detection time it used.",
      "Traffic moving to the secondary only after the check flips.",
      "Controls for check depth, failure threshold, and check interval.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Green while broken. The user requests fail and the checker stays green. Apply Slow detection to see a deep check that still takes 150s. Run the experiment, then apply Recovery and compare the detection time with the 60s warning line.",
  },
  {
    type: "p",
    text: "A green check is evidence about the probe, not about the service. The first question in an incident is always which path the check actually exercises.",
  },
  { type: "sim", simId: "route53-health-checks" },
  { type: "experiment", experimentId: "predict-green-check" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The dependency failed and the user request path broke, but the shallow /healthz probe kept returning 200. Route 53 kept the primary record in its answers because its signal never changed. The check was green for the narrow question it asked, and the service was failing for the question users asked.",
  },
  {
    type: "p",
    text: "A deep, dependency-aware check changed the signal. With a 10s interval and a two-check threshold, detection took about 20s. The slow deep check showed the other half of the tradeoff: the right signal with a 150s detection time still misses a tight recovery objective.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Route 53 health check status and the percentage of checker locations reporting healthy, in CloudWatch under the health check metrics.",
      "The exact health check configuration: path, port, protocol, expected status, string matching, interval, and failure threshold.",
      "User-facing errors, latency, and dependency health from application and load balancer telemetry. A green check does not clear these.",
      "Calculated check child status and the quorum setting; CloudWatch alarm data and the metric behind it.",
      "DNS answers after the check flips, and the client cache window covered in the prerequisite module.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the health check definition before the dashboard. Confirm the path, port, protocol, and expected response. Then compare it with a real user request. If the check is green and users fail, the probe is measuring the wrong thing, not proving the service is healthy.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the critical user path and the dependencies it needs.",
      "Point the check at a readiness endpoint that exercises those dependencies, not only the process.",
      "For private resources, use a CloudWatch alarm health check or a calculated check over public signals.",
      "Set the interval and failure threshold to meet the detection budget without flapping on transient errors.",
      "Test from multiple locations and confirm the 18% aggregation behaves as expected.",
      "Measure the full failover time, including DNS TTL and client caching, before declaring the RTO met.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A deep check catches real failures but can remove a healthy endpoint when a shared dependency has a brief blip.",
      "A shallow check is stable but can stay green through a complete request-path failure.",
      "A 10s interval detects faster and costs more than a 30s interval.",
      "A low failure threshold reacts quickly but is more likely to flap; a high threshold is slower and more tolerant.",
      "Calculated checks reduce false failover but add child checks and a quorum to maintain.",
      "CloudWatch-backed checks reach private signals but inherit the metric delay, statistics, and alarm evaluation behavior.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "green-but-broken",
    question:
      "Route 53 says the primary is healthy, but users get errors from that region. What does the health check actually observe, and what do you check?",
    difficulty: 3,
    hints: [
      "A health check is a probe, not a synthetic user journey.",
      "Read the check definition before reading the status.",
    ],
    answer:
      "I would start with the check definition: path, port, protocol, expected status code, string matching, interval, and failure threshold. A TCP check only proves the port accepts a connection. An HTTP check on /healthz only proves that path returns 2xx; it may not touch the dependency that is failing for users. I would compare a real request with the probe response and check whether the check is an endpoint, calculated, or CloudWatch-backed check. I would also verify the check is seeing the failure from multiple locations and that the DNS answer has actually changed. If the check is shallow, I would move it to a readiness endpoint or a calculated/CloudWatch signal that covers the failing path, then re-measure detection and TTL.",
    followUps: [
      "How would a calculated check change your design?",
      "What would you do if the failing dependency is in a private subnet?",
      "How do you keep a deep check from flapping?",
    ],
    redFlags: [
      "Assumes a green check proves the whole service is healthy.",
      "Changes the threshold before reading the probe path.",
      "Ignores DNS caching after the check flips.",
    ],
    rubric: [
      "Names the probe path, port, and protocol.",
      "Distinguishes liveness from readiness.",
      "Covers calculated and CloudWatch-backed checks.",
      "Includes detection and DNS cache time.",
    ],
  },
  {
    id: "design-health-checks",
    question:
      "Design health checks for an active-passive multi-region service with a 60-second detection budget. What do you choose, and what can go wrong?",
    difficulty: 4,
    hints: [
      "Detection is interval times threshold, plus DNS.",
      "A quorum can be safer than a single check.",
    ],
    answer:
      "I would put a dependency-aware readiness endpoint on each region and use the 10-second interval with a low failure threshold, probably two checks, so detection is about 20 seconds and leaves room for DNS and client cache. I would verify the endpoint checks the critical dependency but does not fail on a non-critical or transient error. If the service has several components, I would use a calculated check with a quorum so one bad child does not remove the region. For private resources, I would use a CloudWatch alarm check on request success and latency. I would test from multiple locations, watch for flapping, and measure the end-to-end failover including TTL. The main risks are a shared dependency causing false failover, a shallow check missing the real failure, and a threshold that is fast enough to flap.",
    followUps: [
      "What quorum would you choose for three regions?",
      "How does a calculated check change the failure threshold?",
      "When would you accept a 30-second interval?",
    ],
    redFlags: [
      "Checks only the process or TCP port.",
      "Chooses the fastest possible threshold without a flapping plan.",
      "Forgets DNS and client cache after detection.",
    ],
    rubric: [
      "Chooses a dependency-aware signal.",
      "Budgets interval and threshold.",
      "Considers calculated or CloudWatch-backed checks.",
      "Names a false-failover risk and a mitigation.",
    ],
  },
  {
    id: "check-type-choice",
    question:
      "When would you use a calculated check or a CloudWatch-backed check instead of a direct endpoint check?",
    difficulty: 3,
    hints: [
      "A direct check has to reach the endpoint from the public internet.",
      "You may care about a fleet or a metric, not one URL.",
    ],
    answer:
      "I would use a calculated check when the unit of health is a fleet or a multi-component service: for example, require at least two of three regions, or at least three of five web servers. The parent check combines child checks with a quorum, which avoids failing over because one child is unhealthy. I would use a CloudWatch-backed check when the signal lives in metrics, or when the resource is private and a public probe cannot reach it. The tradeoff is indirection: a calculated check is only as good as its children, and a CloudWatch check follows the metric data stream, so its delay and statistic matter. A direct endpoint check remains the simplest choice when a public readiness endpoint represents the user path.",
    followUps: [
      "What quorum would you choose for a three-region service?",
      "How does CloudWatch alarm evaluation delay affect detection?",
      "What happens when a calculated check has too few children?",
    ],
    redFlags: [
      "Uses a calculated check without defining the quorum.",
      "Assumes a CloudWatch alarm state is the same as the data stream.",
      "Checks a private IP directly from Route 53 health checkers.",
    ],
    rubric: [
      "Matches the check type to the unit of health.",
      "Explains the quorum for a calculated check.",
      "Explains the data-stream behavior for CloudWatch.",
      "Names the added indirection or delay.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Document every health check: path, port, protocol, expected status, interval, and threshold.",
      "Verify the check exercises the critical user path and its dependencies.",
      "Set an alarm on health check status and on the percentage of healthy checker locations.",
      "Test detection time and the full DNS failover path against the recovery objective.",
      "Decide where a calculated check or CloudWatch-backed check is needed.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the check is green or red before assuming DNS is the problem.",
      "Compare the probe response with a real user request.",
      "Check the checker locations and the 18% aggregation, not only one location.",
      "Watch for false failover caused by a shared dependency or a transient blip.",
      "Record when the check flipped and when clients actually moved.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix the signal, not only the threshold, if the check missed the failure.",
      "Re-measure detection and TTL with the new configuration.",
      "Review calculated check quorums and CloudWatch alarm data sources.",
      "Add a game day that fails a dependency the check is supposed to cover.",
    ],
  },
];

const references = [
  {
    title: "Types of Amazon Route 53 health checks",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-types.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Endpoint, calculated, and CloudWatch-backed health checks, including what each one monitors.",
  },
  {
    title: "How Amazon Route 53 determines whether a health check is healthy",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-determining-health-of-endpoints.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Checker locations, 10s and 30s intervals, response time limits, failure thresholds, and the 18% aggregation rule.",
  },
  {
    title: "Active-active and active-passive failover",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-types.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How health checks interact with failover records and weighted records.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "route53-health-checks": {
      model: route53HealthChecksModel,
      presets,
      instructions:
        "Start Healthy, then apply Green while broken. The checker stays green while users fail. Apply Slow detection and compare the detection time. Use the experiment, then apply Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Route 53 supports 10s and 30s endpoint check intervals and aggregates checker locations with an 18% healthy rule. Detection time here is interval times threshold; real detection also depends on how many locations observe the failure. Traffic moves when the check flips, so DNS cache time is not modeled here; it is covered in the prerequisite module. Secondary capacity and the 50% design load are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-dns-ttl-failover",
    "traffic-route53-routing",
    "traffic-alb-health-checks",
    "observability-synthetic-monitoring",
  ],
};
