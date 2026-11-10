import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ALB_CONNECT_TIMEOUT_MS = 10_000;
const SERVICE_START_MS = 25;

const params = [
  {
    id: "albIdleTimeout",
    label: "ALB idle timeout",
    min: 5,
    max: 120,
    step: 5,
    value: 60,
    unit: " s",
    group: "Load balancer",
    help: "How long the ALB waits for the target to send response bytes. AWS documents a default of 60 seconds; this lab uses a narrowed teaching range.",
    format: "number" as const,
  },
  {
    id: "serviceWorkMs",
    label: "Configured handler work",
    min: 100,
    max: 10_000,
    step: 100,
    value: 2_000,
    unit: " ms",
    group: "Service",
    help: "Configured handler work before the service deadline. The observed work is clamped to the time left before the deadline.",
    format: "ms" as const,
  },
  {
    id: "dependencyDelayMs",
    label: "Configured dependency wait",
    min: 0,
    max: 120_000,
    step: 1_000,
    value: 5_000,
    unit: " ms",
    group: "Service",
    help: "Configured time the service waits on a downstream call after its own work. The observed wait is clamped to the upstream end.",
    format: "ms" as const,
  },
  {
    id: "serviceDeadlineMs",
    label: "Service deadline",
    min: 1_000,
    max: 120_000,
    step: 1_000,
    value: 30_000,
    unit: " ms",
    group: "Service",
    help: "The service's own request deadline. When upstream work would exceed both timers, the shorter timer fires first; a request that finishes inside both succeeds.",
    format: "ms" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Demand {
  albIdleTimeout: number;
  serviceWorkMs: number;
  serviceDeadlineMs: number;
  albDeadlineMs: number;
  totalMs: number;
  success: boolean;
  albFires: boolean;
  timer: string;
  source: string;
  clientElapsed: number;
  upstreamEnd: number;
  dependencyStart: number;
  observedDependencyWaitMs: number;
  orphanedSeconds: number;
  shortfallMs: number;
  headroomMs: number;
}

function demand(p: Params): Demand {
  const albIdleTimeout = Math.max(1, num(p, "albIdleTimeout", 60));
  const rawServiceWorkMs = Math.max(1, num(p, "serviceWorkMs", 2_000));
  const dependencyDelayMs = Math.max(0, num(p, "dependencyDelayMs", 70_000));
  const serviceDeadlineMs = Math.max(1, num(p, "serviceDeadlineMs", 90_000));
  const albDeadlineMs = albIdleTimeout * 1_000;
  const totalMs = rawServiceWorkMs + dependencyDelayMs;
  const success = totalMs <= albDeadlineMs && totalMs <= serviceDeadlineMs;
  const albFires = !success && albDeadlineMs <= serviceDeadlineMs;
  const clientElapsed = success ? totalMs : Math.min(albDeadlineMs, serviceDeadlineMs);
  const upstreamEnd = success
    ? totalMs
    : albFires
      ? Math.min(totalMs, serviceDeadlineMs)
      : serviceDeadlineMs;
  const serviceWorkMs = Math.max(
    1,
    Math.min(rawServiceWorkMs, serviceDeadlineMs - SERVICE_START_MS),
  );
  const dependencyStart = Math.min(SERVICE_START_MS + serviceWorkMs, upstreamEnd);
  const observedDependencyWaitMs = Math.max(0, upstreamEnd - dependencyStart);
  const timer = success ? "none" : albFires ? "ALB idle timeout" : "Service deadline";
  const source = success ? "none" : albFires ? "ELB-generated" : "Target-generated";
  return {
    albIdleTimeout,
    serviceWorkMs,
    serviceDeadlineMs,
    albDeadlineMs,
    totalMs,
    success,
    albFires,
    timer,
    source,
    clientElapsed,
    upstreamEnd,
    dependencyStart,
    observedDependencyWaitMs,
    orphanedSeconds: Math.max(0, upstreamEnd - clientElapsed) / 1_000,
    shortfallMs: Math.max(0, totalMs - albDeadlineMs),
    headroomMs: Math.max(0, albDeadlineMs - upstreamEnd),
  };
}

function formatSeconds(ms: number): string {
  return `${(ms / 1_000).toFixed(1)}s`;
}

function formatSecondsValue(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

function healthForIncident(success: boolean, serviceStillWorking = false): "ok" | "warn" | "crit" {
  if (success) return "ok";
  return serviceStillWorking ? "warn" : "crit";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = demand(p);
  const clientHealth = healthForIncident(d.success);
  const serviceHealth = healthForIncident(d.success, d.albFires && !d.success);
  const dependencyHealth: SimNode["health"] = d.success ? "ok" : "crit";
  const nodes: SimNode[] = [
    {
      id: "client",
      label: d.success ? `Client completes at ${formatSeconds(d.clientElapsed)}` : `Client 504 at ${formatSeconds(d.clientElapsed)}`,
      kind: "client",
      health: clientHealth,
      sublabel: d.success ? "response received" : "client gives up",
      detail: d.success
        ? `The response arrived before both the ${d.albIdleTimeout}s ALB idle timeout and the ${formatSeconds(d.serviceDeadlineMs)} service deadline.`
        : `The client received a 504 after ${formatSeconds(d.clientElapsed)}. The ${d.timer} fired first.`,
      span: {
        start: 0,
        duration: d.clientElapsed,
        depth: 0,
        kind: "client",
        self: 0,
        critical: true,
      },
      meta: { view: "flow", timer: d.timer },
    },
    {
      id: "alb",
      label: d.success ? "Application Load Balancer" : `ALB: ${d.timer}`,
      kind: "lb",
      health: clientHealth,
      sublabel: `idle timeout ${d.albIdleTimeout}s`,
      detail: d.albFires
        ? `The ALB closed the request after ${formatSeconds(d.albDeadlineMs)} without receiving response bytes. The target kept running until ${formatSeconds(d.upstreamEnd)}.`
        : d.success
          ? `The response arrived within the ${d.albIdleTimeout}s idle timeout, so the ALB forwarded it.`
          : `The service returned its own 504 at ${formatSeconds(d.serviceDeadlineMs)}; the ALB forwarded that target response. The ALB idle timeout was ${d.albIdleTimeout}s.`,
      span: {
        start: 1,
        duration: Math.max(1, d.clientElapsed - 1),
        depth: 1,
        kind: "proxy",
        self: 0,
        critical: true,
      },
      meta: { view: "flow", source: d.source },
    },
    {
      id: "service",
      label: `Service · ${formatSeconds(d.serviceWorkMs)}`,
      kind: "service",
      health: serviceHealth,
      sublabel: `waits ${formatSeconds(d.observedDependencyWaitMs)} on dependency`,
      detail: d.albFires
        ? `The handler logged ${formatSeconds(d.serviceWorkMs)} of work, then waited on the dependency. It was still running ${formatSecondsValue(
            d.orphanedSeconds,
          )} after the client received the 504.`
        : d.success
          ? `The handler and dependency finished at ${formatSeconds(d.upstreamEnd)}, inside both deadlines.`
          : `The service deadline fired at ${formatSeconds(d.serviceDeadlineMs)} and returned a 504. The handler's own work was only ${formatSeconds(d.serviceWorkMs)}.`,
      span: {
        start: SERVICE_START_MS,
        duration: Math.max(1, d.upstreamEnd - SERVICE_START_MS),
        depth: 2,
        kind: "server",
        self: Math.max(1, d.serviceWorkMs),
        critical: true,
      },
      meta: { view: "flow", stillWorking: d.albFires && !d.success ? 1 : 0 },
    },
    {
      id: "dependency",
      label: `Dependency · ${formatSeconds(d.observedDependencyWaitMs)}`,
      kind: "db",
      health: dependencyHealth,
      sublabel: d.success ? "within budget" : "holds the request open",
      detail: d.success
        ? "The dependency returned before the service deadline and the ALB idle timeout."
        : "The dependency wait dominates the request. The handler's self-time log does not include this interval.",
      span: {
        start: d.dependencyStart,
        duration: d.observedDependencyWaitMs,
        depth: 3,
        kind: "client",
        self: d.observedDependencyWaitMs,
        critical: true,
      },
      meta: { view: "flow" },
    },
  ];

  if (!d.success) {
    nodes.push({
      id: "timer",
      label: `Expired: ${d.timer}`,
      kind: "service",
      health: "crit",
      sublabel: `${formatSeconds(d.clientElapsed)} · ${d.source}`,
      detail:
        d.timer === "ALB idle timeout"
          ? "The ALB idle timer reached its limit before the target sent response bytes. The upstream may still be working."
          : "The service's own deadline reached its limit. The service generated the 504 and the ALB forwarded it.",
      span: {
        start: Math.max(0, d.clientElapsed - 5),
        duration: 10,
        depth: 0,
        kind: "timer",
        self: 10,
        critical: true,
      },
      meta: { view: "flow" },
    });
  }

  const frame: SimFrame = {
    t: 0,
    nodes,
    edges: [
      edge("client-alb", "client", "alb", 1, clientHealth),
      edge("alb-service", "alb", "service", 1, serviceHealth),
      edge("service-dependency", "service", "dependency", 1, dependencyHealth),
    ],
    metrics: [
      metric("rate-504", "504 rate", d.success ? 0 : 100, "%", 0.5, 2, "percent"),
      metric("client-elapsed", "Client elapsed", d.clientElapsed, " ms", undefined, undefined, "ms"),
      metric("budget-shortfall", "Budget shortfall", d.shortfallMs, " ms", 1_000, 10_000, "ms"),
      metric("orphaned-work", "Upstream work after 504", d.orphanedSeconds, " s", 1, 5, "number"),
      metric("service-log", "Handler work in log", d.serviceWorkMs, " ms", undefined, undefined, "ms"),
      metric("upstream-p99", "Upstream p99", d.upstreamEnd, " ms", undefined, undefined, "ms"),
      metric("dependency-wait", "Observed dependency wait", d.observedDependencyWaitMs, " ms", undefined, undefined, "ms"),
      metric("elb-504", "ELB-generated 504", d.albFires ? 1 : 0, " req", undefined, undefined, "count"),
      metric("target-504", "Target-generated 504", !d.success && !d.albFires ? 1 : 0, " req", undefined, undefined, "count"),
      metric("timeout-headroom", "Headroom to ALB timeout", d.headroomMs, " ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, timer: d.timer, source: d.source },
    summary: d.success
      ? `Client completes at ${formatSeconds(d.clientElapsed)}; ${formatSeconds(
          d.serviceWorkMs,
        )} handler work and ${formatSeconds(d.observedDependencyWaitMs)} dependency wait stay inside both deadlines.`
      : `Client 504 at ${formatSeconds(d.clientElapsed)} (${d.source}); ${formatSeconds(
          d.serviceWorkMs,
        )} logged work, ${formatSeconds(d.upstreamEnd)} total upstream work, ${formatSecondsValue(
          d.orphanedSeconds,
        )} after the client gave up. Timer: ${d.timer}.`,
  };
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "rate-504",
    metricId: "rate-504",
    warn: 0.5,
    crit: 2,
    title: "504 rate crossed the threshold",
    cause:
      "A gateway timer expired before the upstream produced a response. The upstream may still be working, and the service's own log may show only its handler time rather than the full wait.",
    fix:
      "Identify which timer fired before changing any timeout. Compare client elapsed time with the ALB idle timeout and the service deadline, then read target_status_code and target_processing_time.",
    checkFirst: [
      "Compare the client's elapsed time with the ALB idle timeout and the service deadline.",
      "Read the access log for elb_status_code, target_status_code, target_processing_time, and response_processing_time.",
      "Check whether the service or the dependency was still running after the client received the 504.",
    ],
  },
  {
    id: "budget-shortfall",
    metricId: "budget-shortfall",
    warn: 1_000,
    crit: 10_000,
    title: "Upstream work exceeds the ALB budget",
    cause:
      "The handler and dependency take longer than the ALB idle timeout allows. The ALB is asked to wait past its configured budget for response bytes.",
    fix:
      "Shorten the dependency, move it off the synchronous path, or raise the ALB timeout only if the caller and the service deadline can also support the longer budget.",
    checkFirst: [
      "Compare handler self-time with total request time; the gap is usually the dependency wait.",
      "Check the dependency's own timeout and p99, not only its average.",
      "Verify that any retry or backoff happens inside the same total budget.",
    ],
  },
  {
    id: "orphaned-work",
    metricId: "orphaned-work",
    warn: 1,
    crit: 5,
    title: "Upstream work continues after the client received a 504",
    cause:
      "The ALB closed the request at its idle timeout, but the service or dependency kept working. Without deadline propagation or cancellation, the work continues and competes with new requests.",
    fix:
      "Propagate the caller's deadline, cancel or fence abandoned work, and cap retries. Check idempotency before retrying a request that may still be running.",
    checkFirst: [
      "Confirm whether the target completed after the client disconnected.",
      "Check for duplicate side effects or a second charge from a retry.",
      "Compare in-flight work with the request rate after the 504 window.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const gatewayTimeoutModel: SimModel = {
  id: "traffic-504-debug",
  visual: "trace",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p) => {
    const d = demand(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, seed);
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: JSON.stringify(p) };
    next.events = [...frame.events].slice(-60);
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (d.orphanedSeconds > 0 && next.flags.upstreamAfterTimeout !== 1) {
      pushEvent(next, {
        id: "upstream-after-504",
        at: frame.t,
        severity: "crit",
        title: "ALB timed out while the upstream kept working",
        detail: `The client received a 504 at ${formatSeconds(
          d.clientElapsed,
        )}. The service and dependency kept running until ${formatSeconds(
          d.upstreamEnd,
        )}, leaving ${formatSecondsValue(d.orphanedSeconds)} of work after the client left.`,
        nodeId: "service",
        metricId: "orphaned-work",
      });
      next.flags.upstreamAfterTimeout = 1;
    }
    if (d.orphanedSeconds === 0) next.flags.upstreamAfterTimeout = 0;
    if (!d.success && !d.albFires && next.flags.serviceDeadlineEvent !== 1) {
      pushEvent(next, {
        id: "service-deadline-fired",
        at: frame.t,
        severity: "crit",
        title: "The service deadline fired before the ALB timeout",
        detail: `The service returned a 504 at ${formatSeconds(
          d.serviceDeadlineMs,
        )}; the ALB idle timeout was ${d.albIdleTimeout}s. This is a target-generated 504, not an ALB timeout.`,
        nodeId: "service",
        metricId: "target-504",
      });
      next.flags.serviceDeadlineEvent = 1;
    }
    if (d.success || d.albFires) next.flags.serviceDeadlineEvent = 0;
    next.summary = d.success
      ? `Client completes at ${formatSeconds(d.clientElapsed)}; ${formatSeconds(
          d.serviceWorkMs,
        )} handler work and ${formatSeconds(d.observedDependencyWaitMs)} dependency wait stay inside both deadlines.`
      : `Client 504 at ${formatSeconds(d.clientElapsed)} (${d.source}); ${formatSeconds(
          d.serviceWorkMs,
        )} logged work, ${formatSeconds(d.upstreamEnd)} total upstream work, ${formatSecondsValue(
          d.orphanedSeconds,
        )} after the client gave up. Timer: ${d.timer}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = demand(p);
    const items: string[] = [];
    items.push(
      `The client ${d.success ? "completed" : "received a 504"} at ${formatSeconds(d.clientElapsed)}. The ALB idle timeout is ${d.albIdleTimeout}s and the service deadline is ${formatSeconds(d.serviceDeadlineMs)}.`,
    );
    items.push(
      `Handler work is ${formatSeconds(d.serviceWorkMs)}; the observed dependency wait is ${formatSeconds(
        d.observedDependencyWaitMs,
      )}. Total upstream time is ${formatSeconds(d.upstreamEnd)}, so the log line and the request wall time answer different questions.`,
    );
    if (d.success) {
      items.push(
        `The request finished with ${formatSeconds(d.headroomMs)} of headroom to the ALB idle timeout. That is the margin a traffic spike or a slower dependency has to consume.`,
      );
    } else if (d.albFires) {
      items.push(
        `The ALB timed out at ${formatSeconds(d.albDeadlineMs)}. The upstream kept working for another ${formatSecondsValue(
          d.orphanedSeconds,
        )}; without deadline propagation, that work still consumes capacity.`,
      );
    } else {
      items.push(
        `The service deadline fired first at ${formatSeconds(
          d.serviceDeadlineMs,
        )}. The service returned a target-generated 504 and stopped; the ALB idle timeout did not fire.`,
      );
    }
    if (d.albFires) {
      items.push(
        `The ALB also has a ${formatSeconds(ALB_CONNECT_TIMEOUT_MS)} connection timeout and a ${formatSeconds(
          ALB_CONNECT_TIMEOUT_MS,
        )} TLS handshake timeout. This trace models the idle-timeout case because it explains a 60-second response.`,
      );
    }
    return items;
  },
  legend: [
    { label: "Within budget", tone: "ok" },
    { label: "Near budget", tone: "warn" },
    { label: "Timer expired", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Two seconds of handler work and a five-second dependency wait finish well inside both deadlines.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Near budget",
    description: "The dependency takes 55 seconds. The request finishes with three seconds of headroom.",
    tone: "warn",
    params: defaults({ dependencyDelayMs: 55_000, serviceDeadlineMs: 58_000 }),
  },
  {
    id: "failure",
    label: "ALB idle timeout",
    description: "The dependency takes 70 seconds. The client gets a 504 at 60 seconds while the upstream keeps working.",
    tone: "crit",
    params: defaults({ dependencyDelayMs: 70_000, serviceDeadlineMs: 90_000 }),
  },
  {
    id: "service-timeout",
    label: "Service deadline",
    description: "The service deadline is 30 seconds and fires first. The target generates the 504; the ALB merely forwards it.",
    tone: "crit",
    params: defaults({
      albIdleTimeout: 120,
      dependencyDelayMs: 70_000,
      serviceDeadlineMs: 30_000,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The dependency is reduced to 20 seconds. The request completes inside the service and ALB budgets.",
    tone: "ok",
    params: defaults({ dependencyDelayMs: 20_000, serviceDeadlineMs: 30_000 }),
  },
];

const experiment: Experiment = {
  id: "find-expired-timer",
  title: "Find the timer that actually fired",
  simId: "504-debug",
  question:
    "A client gets a 504 at 60 seconds. The service log shows two seconds of handler work. The ALB idle timeout is 60 seconds and the service deadline is 90 seconds. Which timer fired, and what is the upstream doing?",
  prediction: {
    options: [
      {
        id: "alb-idle",
        label:
          "The ALB idle timeout fired at 60 seconds. The service is still waiting on the dependency after the client gave up.",
      },
      {
        id: "service-deadline",
        label: "The service deadline fired at two seconds and the service stopped the request.",
      },
      {
        id: "dependency-504",
        label: "The dependency returned a 504 at two seconds, which the service forwarded.",
      },
      {
        id: "client-timeout",
        label: "The client closed the connection at two seconds because the browser timed out.",
      },
    ],
    correctOptionId: "alb-idle",
    explanation:
      "The client elapsed time equals the 60-second ALB idle timeout, and the service deadline is later at 90 seconds. The handler work is two seconds, but the dependency wait is 70 seconds, so total upstream work is 72 seconds. The ALB closes the request at 60 seconds; the service continues for 12 more seconds because no deadline or cancellation reached it. The two-second log line is handler self-time, not request wall time.",
  },
  setup: defaults({ dependencyDelayMs: 70_000, serviceDeadlineMs: 90_000 }),
  runFor: 20,
  observe: [
    "The client receives a 504 at 60.0s while the service span continues to 72.0s.",
    "Handler work is 2.0s; the dependency wait is 70.0s.",
    "The budget shortfall is 12.0s and 12.0s of upstream work happens after the client leaves.",
    "The service deadline never fires, so this is an ELB-generated 504.",
  ],
  explain:
    "The timer that fired is the ALB idle timeout, not the service deadline. A 504 at 60 seconds with a 90-second service deadline cannot be the service's own timer. The service log is not lying; it reports the handler's self-time. The dependency wait happens after that timed section and is invisible in the log line. The ALB closes the client request, but the upstream keeps working because the deadline was never propagated.",
  fix: defaults({ dependencyDelayMs: 20_000, serviceDeadlineMs: 30_000 }),
  debrief:
    "Reducing the dependency wait to 20 seconds brings total upstream time to 22 seconds, inside both budgets. Raising the ALB timeout to 90 seconds would also hide this symptom, but it would keep failed or abandoned work alive longer and still leave the service deadline outside the caller's budget. Fix the dependency first, then set the service deadline below the ALB idle timeout and the dependency timeout below the service deadline.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A 504 Gateway Timeout means a gateway or proxy did not receive a response from its upstream before one of its timers expired. On an Application Load Balancer (ALB), the timer can be the 10-second connection timeout, the 10-second TLS handshake timeout, or the idle timeout, which defaults to 60 seconds. A target can also return its own 504, which the ALB forwards.",
  },
  {
    type: "p",
    text: "The service in this lab acts as a gateway for its dependency, so its own deadline produces a 504. A plain application without a gateway role might return 503 or 500 instead; the first split still tells you which layer generated the code. The timer comparison is what matters, not the label on the service.",
  },
  {
    type: "p",
    text: "The common trap is a service log that shows two seconds of work while the client waited sixty. That is not necessarily a contradiction. The handler may have logged its own compute time, then waited on a dependency for the rest of the request. When upstream work would exceed both timers, the shorter timer fires first; a request that finishes inside both succeeds. The upstream may still be working after the client is gone.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, ALB, service, dependency. Each layer owns a budget. The ALB idle timeout bounds how long the edge waits for response bytes. The service deadline bounds the service's own work. The dependency timeout bounds the call inside the service. A retry policy adds attempts inside one of those budgets, so it can consume the time without extending the total.",
  },
  {
    type: "table",
    headers: ["Code", "What it means", "First split"],
    rows: [
      ["502", "The gateway could not obtain a valid response from the target.", "Compare ELB 502 with target 5xx; read target_status_code."],
      ["503", "No target can receive traffic, or a target is rejecting with 503.", "Compare ELB 503 with target 5xx; check registration and target state."],
      ["504", "A gateway timer expired before the upstream responded.", "Compare elapsed time with each timeout; read target_status_code and target_processing_time."],
    ],
  },
  {
    type: "p",
    text: "The first split is still ELB-generated versus target-generated. In CloudWatch, compare HTTPCode_ELB_504_Count with HTTPCode_Target_5XX_Count. In access logs, compare elb_status_code with target_status_code. If the target sent a 504, the target 5xx counter moves. If the ALB timed out while waiting, the target status is absent and target_processing_time can be -1 when the target did not respond before the idle timeout.",
  },
  {
    type: "table",
    headers: ["Timer", "Typical value", "What it bounds"],
    rows: [
      ["ALB connection timeout", "10 s", "Time to establish a TCP connection to the target"],
      ["ALB TLS handshake timeout", "10 s", "Time to complete the backend TLS handshake"],
      ["ALB idle timeout", "60 s default, configurable", "Time the ALB waits for response bytes from the target"],
      ["Service deadline", "Application-defined", "Total time the service allows for its own request"],
      ["Dependency timeout", "Application-defined", "Time allowed for one downstream call"],
    ],
  },
  {
    type: "compare",
    leftTitle: "ALB-generated 504",
    rightTitle: "Target-generated 504",
    rows: [
      { label: "Elapsed time", left: "Matches the ALB idle or connection timeout", right: "Matches the service or dependency deadline" },
      { label: "Access log", left: "elb_status_code 504; target_status_code often absent", right: "Both elb_status_code and target_status_code are 504" },
      { label: "Upstream", left: "May still be working after the client leaves", right: "The target stopped and returned its own response" },
      { label: "First fix", left: "Shorten or cancel the upstream path; align the LB budget", right: "Fix the service or dependency deadline and its capacity" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A trace waterfall with client, ALB, service, dependency, and the expired timer marked.",
      "Client elapsed time, observed handler work, observed dependency wait, budget shortfall, and orphaned upstream work.",
      "A preset where the ALB fires first and another where the service deadline fires first.",
      "An event when upstream work continues after the client has already received the 504.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply ALB idle timeout. Compare the client bar ending at 60 seconds with the service bar continuing to 72 seconds. Apply Service deadline and note that the target, not the ALB, generated the 504. Finish with Recovery, then lower the dependency wait.",
  },
  { type: "sim", simId: "504-debug" },
  { type: "experiment", experimentId: "find-expired-timer" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The ALB idle timeout was 60 seconds. The service logged two seconds of handler work, then waited 70 seconds on a dependency, so total upstream time was 72 seconds. The ALB closed the request at 60 seconds and returned a 504. The service kept working for 12 more seconds because no deadline or cancellation reached it.",
  },
  {
    type: "p",
    text: "When the service deadline was moved to 30 seconds and the ALB timeout to 120 seconds, the service returned its own 504 first. The ALB forwarded it, and the target 5xx counter moved instead of the ELB 504 counter. Same client symptom, different owner and different fix.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CloudWatch ALB: HTTPCode_ELB_504_Count, HTTPCode_Target_5XX_Count, TargetResponseTime, RequestCount, and TargetConnectionErrorCount.",
      "Access logs: elb_status_code 504, target_status_code, target_processing_time, response_processing_time, and target:port. A target that never responded before the idle timeout has no target status.",
      "Traces: the client span duration compared with the server and dependency spans. The gap after the client span ends is orphaned work.",
      "Service logs: handler self-time versus request wall time. A two-second log line does not prove the request took two seconds.",
      "Dependency metrics: p99, timeout rate, pool wait, and retry count. A retry can multiply the time spent inside the same budget.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the client elapsed time with the ALB idle timeout and the service deadline before changing either value. Then split ELB 504 from target 504. If the client stopped at the idle timeout while the service kept working, the fix is in the upstream budget and cancellation path, not in the ALB alone.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the timer: client elapsed, ALB idle timeout, service deadline, dependency timeout, and retry count.",
      "Split ELB-generated from target-generated 504s with the access-log status fields and the two 5xx metrics.",
      "Shorten the dependency, move it off the synchronous path, or cache the result so the request fits the budget.",
      "Propagate the caller's deadline to the service and the dependency; cancel or fence work when the client is gone.",
      "Order the budgets: dependency timeout below service deadline, service deadline below the ALB idle timeout, with room for retries.",
      "Verify that retries and backoff happen inside the same total budget and that abandoned work cannot create duplicate side effects.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Raising the ALB idle timeout can stop the 504 and hide a slow dependency, while holding connections and worker slots longer.",
      "A longer timeout also allows abandoned work to run longer after the client leaves, increasing load during an incident.",
      "Aggressive service deadlines return control sooner but can turn a transient dependency stall into a visible error.",
      "Retries improve success for transient failures but can consume the entire budget and add load to a dependency that is already slow.",
      "A synchronous wait is simpler than an asynchronous job, but a request that legitimately needs minutes should usually return a job handle and poll instead of holding a connection open.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "which-timeout",
    question:
      "A client gets a 504 after 60 seconds. The service log shows two seconds of work. How do you determine which timeout fired?",
    difficulty: 2,
    hints: [
      "Compare the client elapsed time with each configured timer.",
      "Handler self-time is not request wall time.",
    ],
    answer:
      "I start with the elapsed time and the configured budgets. If the client stopped at 60 seconds, the ALB idle timeout is 60, and the service deadline is later, the ALB is the leading candidate. I confirm with the access log: an ELB-generated 504 has no target status and may show target_processing_time as -1. Then I compare the service span with the client span. If the service span continues after the client span ends, the upstream was still working. The two-second log line is handler self-time; the remaining time is a dependency wait or another interval outside the logged section.",
    followUps: [
      "What would change if the service deadline were 30 seconds?",
      "How do you prove the upstream continued after the client left?",
      "Which access-log field would you read first?",
    ],
    redFlags: [
      "Assumes the service log duration is the request duration.",
      "Raises a timeout before identifying which one fired.",
      "Ignores whether the target generated the 504.",
    ],
    rubric: [
      "Compares elapsed time with each timer.",
      "Distinguishes handler time from wall time.",
      "Splits ELB from target 504.",
      "Looks for orphaned upstream work.",
    ],
  },
  {
    id: "timeout-budget-order",
    question:
      "How do you order the ALB, service, dependency, and retry timeouts for one request?",
    difficulty: 3,
    hints: [
      "The innermost timeout should fire before the caller's budget is exhausted.",
      "A retry consumes the same total budget unless it is deliberately extended.",
    ],
    answer:
      "I order from the inside out: the dependency timeout is the shortest, the service deadline is larger than the dependency budget but smaller than the ALB idle timeout, and the ALB idle timeout is the outer bound. I leave margin for network and serialization time and for retries or backoff. The caller's deadline should propagate rather than restart at each hop. If the route timeout includes retries, the retry policy must fit inside that one budget. The goal is for the innermost timer to fire first and produce a useful error while the caller still has time to handle it.",
    followUps: [
      "What happens if a retry resets the deadline?",
      "How much margin do you leave between layers?",
      "When is a longer ALB timeout the correct choice?",
    ],
    redFlags: [
      "Sets every hop to the same timeout.",
      "Lets each retry start a fresh full budget.",
      "Makes the dependency timeout longer than the service deadline.",
    ],
    rubric: [
      "Orders dependency, service, and ALB budgets.",
      "Propagates deadlines.",
      "Accounts for retries inside the total.",
      "Leaves margin and explains why.",
    ],
  },
  {
    id: "raise-idle-timeout",
    question:
      "Raising the ALB idle timeout from 60 to 300 seconds stops the 504s. What could go wrong, and what would you do instead?",
    difficulty: 3,
    hints: [
      "A longer wait holds resources on both sides.",
      "The client may have its own timeout.",
    ],
    answer:
      "It hides the slow path rather than fixing it. Connections, worker slots, and in-flight requests stay occupied five times longer, so a dependency stall can exhaust capacity while clients wait. The client or an upstream proxy may still time out before 300 seconds. If a retry happens after the client leaves, abandoned work can duplicate side effects. I would first shorten the dependency or move it off the synchronous path, propagate a deadline, and set the service deadline below the ALB idle timeout. I would raise the ALB timeout only for a known long-running request with a matching caller budget and a plan for cancellation.",
    followUps: [
      "How would you handle a legitimate five-minute export?",
      "What client-side timeout would you check?",
      "How do you prevent duplicate side effects after a 504?",
    ],
    redFlags: [
      "Treats the timeout increase as the root-cause fix.",
      "Ignores client and upstream timeouts.",
      "Retries a non-idempotent request after an ambiguous 504.",
    ],
    rubric: [
      "Explains resource holding and blast radius.",
      "Checks the caller budget.",
      "Proposes dependency and cancellation fixes.",
      "Names idempotency for retries.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The ALB idle timeout, service deadline, dependency timeout, and retry policy are documented together.",
      "Dashboards separate HTTPCode_ELB_504_Count from HTTPCode_Target_5XX_Count.",
      "Traces compare client, server, and dependency spans on the same request.",
      "Deadline propagation and cancellation are implemented for the critical request path.",
      "Long-running work has an asynchronous job path instead of an open connection.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare client elapsed time with each timer before changing a timeout.",
      "Split ELB-generated from target-generated 504s in the access log.",
      "Check whether the upstream is still working after the client received the 504.",
      "Measure the dependency wait separately from handler self-time.",
      "Bound retries and confirm idempotency before retrying an ambiguous failure.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the 504 rate, client elapsed time, upstream completion time, and retry volume at peak.",
      "Align the budgets inside out and leave margin for network and backoff.",
      "Add an alert for orphaned work after client disconnects.",
      "Record which timer fired and which layer owned the fix.",
    ],
  },
];

const references = [
  {
    title: "Troubleshoot your Application Load Balancers: HTTP 504",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html#http-504-issues",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The 10-second connection and TLS handshake timeouts, the idle timeout case, and target content-length behavior.",
  },
  {
    title: "Application Load Balancers: load balancer attributes",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The idle_timeout.timeout_seconds attribute and its 60-second default.",
  },
  {
    title: "Envoy router filter: request timeouts and retries",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/router_filter",
    publisher: "Envoy",
    kind: "docs" as const,
    note: "The route timeout includes retries, 504 behavior, and the upstream_rq_timeout counter.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "504-debug": {
      model: gatewayTimeoutModel,
      presets,
      instructions:
        "Start Healthy, then apply ALB idle timeout. Compare the client bar ending at 60 seconds with the service bar continuing to 72 seconds. Apply Service deadline and note the target-generated 504. Finish with Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Configured handler work and dependency wait are inputs; observed work and wait are clamped to the active deadlines. Timeout ranges are teaching values. AWS documents the ALB connection and idle timeouts and the ELB/target 504 split, not these exact numbers.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-timeouts",
    "traffic-keepalive-idle-timeout",
    "traffic-502-debug",
    "traffic-503-debug",
  ],
};
