import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const APP_P99 = 6.5;
const CLIENT_DEADLINE = 8;

const params = [
  {
    id: "meshTimeout",
    label: "Mesh default timeout",
    min: 5,
    max: 60,
    step: 1,
    value: 30,
    unit: " s",
    group: "Mesh policy",
    help: "The baseline timeout applied to every proxy that no more specific policy matches.",
    format: "number" as const,
  },
  {
    id: "teamTimeout",
    label: "Team policy timeout",
    min: 1,
    max: 30,
    step: 1,
    value: 10,
    unit: " s",
    group: "Team policy",
    help: "The timeout set by the broader team policy. It covers every pod in the team's label selector.",
    format: "number" as const,
  },
  {
    id: "serviceTimeout",
    label: "Service policy timeout",
    min: 1,
    max: 30,
    step: 1,
    value: 8,
    unit: " s",
    group: "Service policy",
    help: "The timeout intended for Checkout. It applies only to pods the service policy's selector matches.",
    format: "number" as const,
  },
  {
    id: "selectorCoverage",
    label: "Service selector coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Selector",
    help: "Share of Checkout pods matched by the service policy. Pods outside the selector fall back to the team policy.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function cutRate(timeout: number): number {
  if (timeout < APP_P99) return ((APP_P99 - timeout) / APP_P99) * 80;
  if (timeout > CLIENT_DEADLINE) return ((timeout - CLIENT_DEADLINE) / 22) * 15 + 2;
  return 0;
}

interface Outcome {
  meshTimeout: number;
  teamTimeout: number;
  serviceTimeout: number;
  coverage: number;
  effective: number;
  coveredError: number;
  uncoveredError: number;
  errorRate: number;
  cutMargin: number;
  broadPods: number;
  deadlineOverrun: number;
  p99: number;
}

function compute(p: Params): Outcome {
  const meshTimeout = Math.max(1, num(p, "meshTimeout", 30));
  const teamTimeout = Math.max(1, num(p, "teamTimeout", 10));
  const serviceTimeout = Math.max(1, num(p, "serviceTimeout", 8));
  const coverage = clamp(num(p, "selectorCoverage", 100), 0, 100);
  const coveredError = cutRate(serviceTimeout);
  const uncoveredError = cutRate(teamTimeout);
  const errorRate = (coverage / 100) * coveredError + (1 - coverage / 100) * uncoveredError;
  const effective = (coverage / 100) * serviceTimeout + (1 - coverage / 100) * teamTimeout;
  return {
    meshTimeout,
    teamTimeout,
    serviceTimeout,
    coverage,
    effective,
    coveredError,
    uncoveredError,
    errorRate,
    cutMargin: Math.max(0, APP_P99 - effective),
    broadPods: 100 - coverage,
    deadlineOverrun: Math.max(0, effective - CLIENT_DEADLINE),
    p99: Math.min(5_000, effective * 1_000),
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(o: Outcome, seed: number): SimFrame {
  const clientHealth = healthFor(o.errorRate, 1, 5);
  const proxyHealth = healthFor(o.errorRate, 1, 5);
  return {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: 10_000,
        sublabel: "10,000 rps · 8s deadline",
        meta: { view: "flow" },
      },
      {
        id: "mesh-policy",
        label: "Mesh default",
        kind: "mesh",
        health: "ok",
        throughput: 10_000,
        sublabel: `${o.meshTimeout}s · baseline`,
        detail: "Applies only when no more specific policy matches the proxy. It is the fallback, not an override.",
        meta: { view: "flow" },
      },
      {
        id: "team-policy",
        label: "Team policy",
        kind: "mesh",
        health: o.coverage < 100 ? "warn" : "ok",
        throughput: 10_000,
        sublabel: `${o.teamTimeout}s · broad selector`,
        detail: `Matches every Checkout pod through the team label. Where the service policy does not match, this timeout is the effective one.`,
        meta: { view: "flow" },
      },
      {
        id: "service-policy",
        label: "Service policy",
        kind: "mesh",
        health: o.coverage >= 100 ? "ok" : o.coverage > 0 ? "warn" : "crit",
        throughput: (10_000 * o.coverage) / 100,
        sublabel: `${o.serviceTimeout}s · ${Math.round(o.coverage)}% of pods`,
        detail: `The intended Checkout timeout. It applies only to the ${Math.round(o.coverage)}% of pods its selector matches. Unmatched pods silently keep the broader timeout.`,
        meta: { view: "flow" },
      },
      {
        id: "proxy",
        label: "Envoy · effective config",
        kind: "mesh",
        health: proxyHealth,
        throughput: 10_000,
        sublabel: `${o.effective.toFixed(1)}s effective`,
        detail: `The only timeout that matters at request time. Covered pods use ${o.serviceTimeout}s; uncovered pods use ${o.teamTimeout}s. The mesh default is ${o.meshTimeout}s.`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Checkout",
        kind: "service",
        health: proxyHealth,
        utilization: clamp(o.errorRate / 100),
        throughput: 10_000,
        sublabel: `app p99 ${APP_P99}s · deadline ${CLIENT_DEADLINE}s`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-proxy", "clients", "proxy", 1, clientHealth),
      edge("mesh-proxy", "mesh-policy", "proxy", 0.2, "ok"),
      edge("team-proxy", "team-policy", "proxy", 1, "ok"),
      edge("service-proxy", "service-policy", "proxy", o.coverage / 100, o.coverage >= 100 ? "ok" : "warn"),
      edge("proxy-service", "proxy", "service", 1, proxyHealth),
    ],
    metrics: [
      metric("error-rate", "Failed requests", o.errorRate, "%", 1, 5, "percent"),
      metric("cut-margin", "Timeout below app p99", o.cutMargin, " s", 0.5, 2, "number"),
      metric("broad-pods", "Pods on the broad policy", o.broadPods, "%", 5, 30, "percent"),
      metric("deadline-overrun", "Timeout above client deadline", o.deadlineOverrun, " s", 0.5, 2, "number"),
      metric("effective-timeout", "Effective timeout", o.effective, " s", undefined, undefined, "number"),
      metric("p99", "Proxy p99", o.p99, "ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      coverage: o.coverage,
      team: o.teamTimeout,
      service: o.serviceTimeout,
      mesh: o.meshTimeout,
      err: o.errorRate,
      shadowed: 0,
      paramsKey: "",
    },
    summary: `${Math.round(o.coverage)}% selector coverage; effective timeout ${o.effective.toFixed(1)}s; ${o.errorRate.toFixed(1)}% errors.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = Math.abs(item.value) * 0.01 + 0.05;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.99 + 0.02 * Math.sin((index + (seed % 5)) / 2.5)) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "The effective policy is failing requests",
    cause:
      "The timeout that actually applies to the proxy does not match the application's latency. Either the service policy did not match, or a broader policy won where it should not have.",
    fix:
      "Read the effective config per proxy, not the intended policy list. Fix the selector or the precedence, then verify the timeout against the application p99 and the client deadline.",
    checkFirst: [
      "Compare the intended service policy with the matched policy for each proxy.",
      "Check the selector labels and namespace on the service policy.",
      "Check whether a broader policy matches the same pods.",
    ],
  },
  {
    id: "cut-margin",
    metricId: "cut-margin",
    warn: 0.5,
    crit: 2,
    title: "The proxy timeout is below the application's p99",
    cause:
      "A short effective timeout cuts requests that the application would have completed. The proxy returns a timeout before the service can finish, and retries can amplify the work.",
    fix:
      "Raise the effective timeout above the application p99, or reduce the application's tail latency. Keep the client deadline above the proxy timeout so the client does not give up first.",
    checkFirst: [
      "Compare the effective timeout with the application p99, not its average.",
      "Check which policy supplied the effective timeout.",
      "Check whether retries are multiplying the cut requests.",
    ],
  },
  {
    id: "broad-pods",
    metricId: "broad-pods",
    warn: 5,
    crit: 30,
    title: "Most pods are governed by the broad policy",
    cause:
      "The specific policy's selector matches only part of the workload. The remaining pods fall back to the team policy, so one service runs with two different timeouts and two different behaviors.",
    fix:
      "Fix the selector so the specific policy matches every intended pod, or narrow the broad policy so it cannot silently define the service's behavior. Verify coverage per proxy, not per policy.",
    checkFirst: [
      "Count pods matched by each policy, not policies in the API.",
      "Check labels, namespace, and targetRef kind for a mismatch.",
      "Check whether the broad policy was meant as a baseline or an override.",
    ],
  },
  {
    id: "deadline-overrun",
    metricId: "deadline-overrun",
    warn: 0.5,
    crit: 2,
    title: "The proxy timeout is above the client deadline",
    cause:
      "The client gives up before the proxy does. The proxy keeps the upstream request open for work nobody is waiting for, and the client records a timeout that the service may not see.",
    fix:
      "Keep the proxy timeout below the client deadline, with room for retries. Fix the policy that supplied the too-long effective timeout.",
    checkFirst: [
      "Compare the effective proxy timeout with the client deadline.",
      "Check whether the client or an upstream gateway enforces a shorter deadline.",
      "Check whether the proxy keeps working after the client disconnects.",
    ],
  },
];

export const policyConflictModel: SimModel = {
  id: "policy-conflict",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(compute(defaults()), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const o = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(o, seed);
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: key };
    next.flags.shadowed = Number(frame.flags.shadowed ?? 0);
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, seed);
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    const jitter = rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(1, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    const prevCoverage = Number(frame.flags.coverage ?? 100);
    const prevErr = Number(frame.flags.err ?? 0);
    if (o.coverage < 100 && prevCoverage >= 100) {
      pushEvent(next, {
        id: "selector-drift",
        at: frame.t,
        severity: "warn",
        title: "Service policy no longer matches every pod",
        detail: `Selector coverage is ${Math.round(o.coverage)}%. Uncovered pods fall back to the team policy at ${o.teamTimeout}s instead of ${o.serviceTimeout}s.`,
        nodeId: "service-policy",
        metricId: "broad-pods",
      });
    }
    if (o.coverage >= 100 && prevCoverage < 100) {
      pushEvent(next, {
        id: "selector-recovered",
        at: frame.t,
        severity: "info",
        title: "Service policy is effective on every pod",
        detail: `Every Checkout pod now receives the ${o.serviceTimeout}s service timeout.`,
        nodeId: "service-policy",
      });
    }
    if (o.coverage < 50 && o.teamTimeout < APP_P99 && Number(frame.flags.shadowed ?? 0) !== 1) {
      pushEvent(next, {
        id: "broad-policy-wins",
        at: frame.t,
        severity: "crit",
        title: "The broad policy is defining the service timeout",
        detail: `${Math.round(100 - o.coverage)}% of pods use the team timeout of ${o.teamTimeout}s, which is below the application p99 of ${APP_P99}s. The intended service timeout is not in effect.`,
        nodeId: "team-policy",
        metricId: "cut-margin",
      });
      next.flags.shadowed = 1;
    }
    if (o.errorRate >= 5 && prevErr < 5) {
      pushEvent(next, {
        id: "policy-errors",
        at: frame.t,
        severity: "crit",
        title: "The effective timeout is failing requests",
        detail: `${o.errorRate.toFixed(1)}% of requests fail. Covered pods use ${o.serviceTimeout}s; uncovered pods use ${o.teamTimeout}s; the client deadline is ${CLIENT_DEADLINE}s.`,
        nodeId: "proxy",
        metricId: "error-rate",
      });
    }
    if (o.errorRate < 1 && prevErr >= 1) {
      pushEvent(next, {
        id: "policy-recovered",
        at: frame.t,
        severity: "info",
        title: "The effective timeout is inside the request budget",
        detail: "Failed requests have cleared. Verify that the matched policy, not just the API object, is the one you intended.",
        nodeId: "proxy",
      });
    }
    next.summary = `${Math.round(o.coverage)}% selector coverage; effective timeout ${o.effective.toFixed(1)}s; ${o.errorRate.toFixed(1)}% errors.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const o = compute(p);
    return [
      `The intended service timeout is ${o.serviceTimeout}s, but only ${Math.round(o.coverage)}% of pods match its selector. The other ${Math.round(100 - o.coverage)}% use the team timeout of ${o.teamTimeout}s.`,
      `The traffic-weighted effective timeout is ${o.effective.toFixed(1)}s. That is the only number the request path experiences.`,
      `The application p99 is ${APP_P99}s and the client deadline is ${CLIENT_DEADLINE}s. The current configuration is ${o.cutMargin.toFixed(1)}s below p99 and ${o.deadlineOverrun.toFixed(1)}s above the deadline.`,
      "Kuma applies the single most specific matching policy. When two policies are equally specific, the most recently modified one wins. A selector that matches nothing is not a conflict; it is a silent fallback.",
      "Read the matched policies for a specific data plane proxy, not the list of policies in the API. The proxy's effective config is the source of truth.",
    ];
  },
  legend: [
    { label: "Effective", tone: "ok" },
    { label: "Partial match", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Not matched", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Service policy matches every pod at 8s. The application p99 is 6.5s and the client deadline is 8s.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Selector drift",
    description: "The service policy matches 80% of pods. The rest fall back to a 14s team timeout, above the client deadline.",
    tone: "warn",
    params: defaults({ meshTimeout: 30, teamTimeout: 14, serviceTimeout: 8, selectorCoverage: 80 }),
  },
  {
    id: "failure",
    label: "Broad policy wins",
    description: "The service selector matches no pods. Every proxy uses the team's 2s timeout, far below the 6.5s p99.",
    tone: "crit",
    params: defaults({ meshTimeout: 30, teamTimeout: 2, serviceTimeout: 8, selectorCoverage: 0 }),
  },
  {
    id: "conflict",
    label: "Split workload",
    description: "Half the pods use a 4s service timeout, half use a 12s team timeout. One service, two behaviors.",
    tone: "crit",
    params: defaults({ meshTimeout: 30, teamTimeout: 12, serviceTimeout: 4, selectorCoverage: 50 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Coverage is back to 100% and the service timeout is 8s. The team policy still exists but no longer decides.",
    tone: "ok",
    params: defaults({ meshTimeout: 30, teamTimeout: 10, serviceTimeout: 8, selectorCoverage: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-policy-winner",
  title: "Predict which timeout applies",
  simId: "policy-conflict",
  question:
    "A team policy sets a 2s timeout for every Checkout pod. A service policy sets 8s, but its selector matches no pods. The mesh default is 30s. What timeout does the proxy apply?",
  prediction: {
    options: [
      { id: "service", label: "8s, because the service policy is more specific and was created later" },
      { id: "team", label: "2s, because the service policy never matches, so the team policy is the most specific match" },
      { id: "mesh", label: "30s, because two policies conflict and the mesh default breaks the tie" },
      { id: "average", label: "About 13s, because the mesh averages the matching timeouts" },
    ],
    correctOptionId: "team",
    explanation:
      "Precedence only applies to policies that match. The service policy selects no pods, so it contributes nothing. The team policy matches every Checkout pod and is more specific than the mesh default, so its 2s timeout is the effective config. The conflict is invisible if you read the policy list instead of the matched policy for the proxy.",
  },
  setup: defaults({ meshTimeout: 30, teamTimeout: 2, serviceTimeout: 8, selectorCoverage: 0 }),
  runFor: 30,
  observe: [
    "The service policy object exists, but 0% of pods match it.",
    "The effective timeout is 2s, not 8s or 30s.",
    "Failed requests exceed 50% because 2s is far below the 6.5s p99.",
    "The broad-policy warning is visible on the team policy node.",
  ],
  explain:
    "A policy is not in effect just because it exists. Kuma evaluates the policies that match a given proxy and applies the single most specific one. With no match from the service policy, the team policy is the most specific match and beats the mesh default. The fix is to repair the selector, then verify the matched policy for a real proxy. Reading the API list would have shown the 8s policy and hidden the 2s behavior.",
  fix: defaults({ meshTimeout: 30, teamTimeout: 10, serviceTimeout: 8, selectorCoverage: 100 }),
  debrief:
    "With full coverage, the service policy applies at 8s, just under the client deadline. Errors drop to zero. The team policy still exists at 10s for other services, which is fine because it no longer matches Checkout. The durable control is an ownership rule: every service has one policy at the most specific scope, and a coverage check alerts when a selector stops matching.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A mesh policy conflict happens when more than one policy could apply to the same proxy and the result is not what the operator intended. Kuma evaluates the policies that match a data plane proxy and applies the single most specific one. Specificity is based on the selector: a policy with more exact tag matches beats one with fewer or wildcard matches. If two policies are equally specific, the most recently modified one wins.",
  },
  {
    type: "p",
    text: "The important word is match. A service policy with a selector that matches no pods is not a winning policy; it is not in the competition. The broader team policy then remains the most specific match, and its timeout becomes the effective config. The API still shows both objects, which is why a policy review can look correct while the request path behaves differently.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The control plane evaluates policies and distributes the result to each data plane proxy. With newer Kuma policies, a `targetRef` names the mesh, service, or subset the policy applies to; the control plane resolves that reference per proxy. The proxy receives one effective configuration, not a stack of policies that it evaluates at request time. This is good for performance and bad for intuition: the decision happened earlier, somewhere else.",
  },
  {
    type: "table",
    headers: ["Scope", "Typical owner", "What it should decide"],
    rows: [
      ["Mesh", "Platform team", "Safe baseline for every proxy"],
      ["Team or namespace", "Service team", "Defaults shared by a group of services"],
      ["Service", "Service owner", "Timeouts, retries, and limits for one service"],
      ["Subset", "Service owner", "Behavior for a version or canary"],
    ],
  },
  {
    type: "p",
    text: "Scope is not the same as specificity. A team policy with many exact labels can be more specific than a service policy with one wildcard. A policy that selects all pods in a namespace is broad even if its name says checkout. Read the selector and the matched proxies, not the policy's title.",
  },
  {
    type: "compare",
    leftTitle: "Intended configuration",
    rightTitle: "Effective configuration",
    rows: [
      { label: "What it shows", left: "Every policy object in the API", right: "One resolved policy per proxy" },
      { label: "Timeout", left: "The value the author typed", right: "The value the proxy enforces" },
      { label: "Selector failure", left: "Looks like a valid object", right: "Falls back to a broader policy" },
      { label: "Debugging", left: "Search policy names and hope", right: "Inspect matched policies for a proxy" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A mesh default, a team policy, and a service policy, each with its own timeout.",
      "A service selector coverage control that changes how many pods the specific policy matches.",
      "The effective timeout at the proxy, plus failed requests, timeout margin, broad-policy coverage, and deadline overrun.",
      "A policy graph that shows which policy is connected to the proxy.",
      "Events when the selector drifts, when the broad policy takes over, and when the effective config recovers.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and confirm that the service policy matches every pod. Apply Selector drift and watch the effective timeout move toward the team value. Apply Broad policy wins and compare 2s with the 6.5s p99. Then repair coverage and confirm the effective timeout returns to 8s.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Teaching values",
    body: "The selectors, timeouts, and error curve are illustrative teaching values. Real Kuma precedence uses the most specific matching policy and the latest modification time for a tie; this model simplifies the selector to a coverage percentage.",
  },
  { type: "sim", simId: "policy-conflict" },
  { type: "experiment", experimentId: "predict-policy-winner" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The service policy was intended to set an 8s timeout for Checkout. Its selector matched only part of the workload, or none of it. The uncovered pods fell back to the team policy, and the proxy applied whichever policy was the most specific match for that pod. The effective timeout was not the one in the service policy, even though the policy object existed and looked correct.",
  },
  {
    type: "p",
    text: "The split-workload preset made the consequence visible: one service ran with two timeouts. Covered pods cut requests at 4s; uncovered pods waited until 12s, past the client deadline. Both cohorts produced errors for different reasons, and neither matched the intended 8s. Policy conflicts are rarely one wrong value; they are two different behaviors coexisting under one service name.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "The matched policy for a specific data plane proxy, not only the list of policies in the API.",
      "Per-pod timeout behavior: 504 rate, upstream request duration, and client cancellations.",
      "Selector coverage: how many pods each policy actually matches, by label and namespace.",
      "Kuma's inspect API for matched policies and affected data plane proxies.",
      "The proxy's effective config from the control plane or the Envoy config dump.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Pick one failing proxy and read its matched policy. Compare that policy's selector with the pod's labels. Then compare the effective timeout with the application p99 and the client deadline. Do not start by reading every policy in the API; the list cannot tell you which one won.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Repair the specific policy's selector, or narrow the broad policy until it no longer covers the service.",
      "Verify coverage per proxy, not per policy object.",
      "Check the effective timeout against the application p99 and the client deadline.",
      "Add an alert when a service's matched policy changes or when coverage drops below 100%.",
      "Record policy ownership: one owner per service scope, and a review for broad scopes.",
      "Re-test with a real pod, including its labels and namespace, not a synthetic selector.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A broad baseline is easy to operate and easy to accidentally override a service's intent.",
      "Per-service policies are precise and create more objects to own, review, and keep in sync.",
      "Strict selector validation catches typos early but can block a legitimate gradual rollout.",
      "The latest-modified tie-break is deterministic but not obvious; two equal policies can change behavior with an unrelated edit.",
      "Removing a broad policy reduces ambiguity but leaves services without a safe fallback.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "which-policy-wins",
    question:
      "Two policies set different timeouts for the same service. How do you determine which one applies?",
    difficulty: 3,
    hints: [
      "Precedence applies only to policies that match.",
      "Specificity first; modification time breaks a tie.",
    ],
    answer:
      "I would pick a real proxy for the service and inspect its matched policy, not the policy list. Kuma applies the single most specific matching policy; if two are equally specific, the most recently modified one wins. I would compare each policy's selector with the pod's labels and namespace, then read the effective config the proxy received. If the service policy's selector matches nothing, it is not in the running, and the broader policy is the effective one.",
    followUps: [
      "How would you prove the selector matches the pod?",
      "What does the inspect API show?",
      "What would you change to make the result unambiguous?",
    ],
    redFlags: [
      "Assumes the newest policy always wins.",
      "Reads only the policy objects.",
      "Ignores selector labels.",
    ],
    rubric: [
      "Inspects a real proxy.",
      "Explains specificity and the tie-break.",
      "Checks selector coverage.",
      "Reads effective config.",
    ],
  },
  {
    id: "partial-rollout",
    question:
      "A service policy matches 60% of pods. What are the risks, and how would you finish the rollout?",
    difficulty: 3,
    hints: [
      "Two behaviors coexist under one service name.",
      "Coverage is a metric, not a one-time check.",
    ],
    answer:
      "The risk is a split workload: 60% of pods use the intended timeout and 40% use the broader fallback. Errors, latency, and retry behavior differ by pod, which makes the service look inconsistent and the incident hard to localize. I would confirm the missing selector labels, fix them, and watch coverage per proxy until it reaches 100%. I would also compare the two cohorts' error and latency rates before and after, so the rollout does not hide a second problem.",
    followUps: [
      "How would you detect the split from metrics?",
      "Would you roll back or roll forward?",
      "What if the missing pods are intentionally excluded?",
    ],
    redFlags: [
      "Assumes a policy applies to the whole service.",
      "Checks only the control plane's accepted objects.",
      "Ignores per-pod behavior.",
    ],
    rubric: [
      "Names the split-workload risk.",
      "Checks selector labels.",
      "Measures coverage per proxy.",
      "Compares cohorts.",
    ],
  },
  {
    id: "policy-ownership",
    question:
      "How would you design policy ownership so conflicts are debuggable?",
    difficulty: 4,
    hints: [
      "One owner per scope.",
      "Make coverage and effective config observable.",
    ],
    answer:
      "I would assign one owner per scope: platform owns the mesh baseline, service teams own service and subset policies, and no team writes a broad policy that covers another team's service without review. I would require selectors to be explicit and tested against real labels, add alerts for coverage below 100%, and expose the matched policy and effective config per proxy. I would also keep a small set of policy types, because overlapping types multiply the combinations that have to be reasoned about during an incident.",
    followUps: [
      "Who approves a change to the mesh baseline?",
      "How would you test a selector before applying it?",
      "What would you do with a legacy broad policy?",
    ],
    redFlags: [
      "Lets every team write any scope.",
      "Relies on naming conventions alone.",
      "Has no coverage alert.",
    ],
    rubric: [
      "Assigns ownership by scope.",
      "Requires explicit selectors.",
      "Makes effective config observable.",
      "Limits policy surface.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every service has one policy owner at the most specific scope.",
      "Broad policies are reviewed by the teams whose services they can match.",
      "Selectors are tested against real pod labels and namespaces.",
      "Coverage is monitored per proxy, with an alert when a specific policy stops matching.",
      "The effective timeout is compared with the application p99 and the client deadline.",
      "The matched policy for a sample proxy is checked after every policy change.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Pick a failing proxy and read its matched policy.",
      "Compare the selector with the pod's labels and namespace.",
      "Check whether the service policy matches any pods at all.",
      "Compare the effective timeout with the application p99 and the client deadline.",
      "Look for a split workload: different error or latency by pod.",
      "Record the policy change and the time the effective config changed.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Repair or narrow the selector and confirm coverage reaches 100%.",
      "Remove or scope the broad policy that filled the gap.",
      "Add a coverage alert and a matched-policy check to the deploy pipeline.",
      "Re-test the timeout against the application p99 under peak load.",
      "Document the ownership rule that would have prevented the conflict.",
    ],
  },
];

const references = [
  {
    title: "How Kuma chooses the right policy to apply",
    url: "https://kuma.io/docs/latest/policies/how-kuma-chooses-the-right-policy-to-apply/",
    publisher: "Kuma Project",
    kind: "docs" as const,
    note: "Specificity rules, exact versus wildcard matches, and the latest-modification tie-break.",
  },
  {
    title: "Kuma policies introduction",
    url: "https://kuma.io/docs/latest/policies/introduction/",
    publisher: "Kuma Project",
    kind: "docs" as const,
    note: "Policy roles, targetRef, and how policies are scoped to data plane proxies.",
  },
  {
    title: "Kuma Inspect API",
    url: "https://kuma.io/docs/latest/explore/inspect-api/",
    publisher: "Kuma Project",
    kind: "docs" as const,
    note: "Matched policies, affected data plane proxies, and the Envoy config a proxy received.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "policy-conflict": {
      model: policyConflictModel,
      presets,
      instructions:
        "Start Healthy, then apply Selector drift and Broad policy wins. Read the effective timeout before the error rate. Repair coverage with Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Selectors are simplified to a coverage percentage; real Kuma precedence also considers exact tag matches and modification time.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mesh-kuma-control-plane", "mesh-timeouts", "mesh-retries", "mesh-mtls"],
};
