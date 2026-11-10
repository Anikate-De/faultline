import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const WINDOW_SECONDS = 10;

const params = [
  {
    id: "algorithm",
    label: "Limiter algorithm",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Limiter",
    help: "Zero is token bucket. One is fixed window. Two is sliding window. The window is ten seconds in this model.",
    format: "count" as const,
  },
  {
    id: "trafficRps",
    label: "Offered traffic",
    min: 500,
    max: 20_000,
    step: 500,
    value: 1_000,
    unit: " rps",
    group: "Traffic",
    help: "Average requests per second arriving at the limiter before any rejection.",
    format: "rps" as const,
  },
  {
    id: "limitRps",
    label: "Configured limit",
    min: 500,
    max: 10_000,
    step: 100,
    value: 2_000,
    unit: " rps",
    group: "Limiter",
    help: "The sustained rate the limiter is supposed to enforce.",
    format: "rps" as const,
  },
  {
    id: "burstSize",
    label: "Bucket capacity",
    min: 0,
    max: 20_000,
    step: 100,
    value: 500,
    unit: " req",
    group: "Limiter",
    help: "Tokens a bucket can hold. It is the largest instantaneous burst a token bucket admits, and it is ignored by the window algorithms.",
    format: "count" as const,
  },
  {
    id: "boundaryShare",
    label: "Boundary concentration",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Traffic",
    help: "Share of traffic that arrives in two short pulses around each window boundary. Zero spreads traffic evenly.",
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

interface Computed {
  algorithm: number;
  traffic: number;
  limit: number;
  burst: number;
  concentration: number;
  admitted: number;
  rejected: number;
  rejectionRate: number;
  peakRate: number;
  multiplier: number;
  fixedWindowCapacity: number;
}

function compute(p: Params): Computed {
  const algorithm = Math.round(clamp(num(p, "algorithm", 0), 0, 2));
  const traffic = Math.max(1, num(p, "trafficRps", 3_000));
  const limit = Math.max(1, num(p, "limitRps", 2_000));
  const burst = Math.max(0, num(p, "burstSize", 500));
  const concentration = clamp(num(p, "boundaryShare", 0) / 100);
  const ratio = traffic / limit;

  let admitted = Math.min(traffic, limit);
  let multiplier = 1;
  if (algorithm === 1) {
    const boundaryExposure = 1 + (Math.min(2, ratio) - 1) * concentration;
    multiplier = Math.max(1, boundaryExposure);
  } else if (algorithm === 0) {
    multiplier = Math.max(1, Math.min(ratio, 1 + burst / (limit * WINDOW_SECONDS)));
    admitted = Math.min(traffic, limit + burst / WINDOW_SECONDS);
  }

  const peakRate = Math.min(traffic, limit * multiplier);
  const rejected = Math.max(0, traffic - admitted);
  return {
    algorithm,
    traffic,
    limit,
    burst,
    concentration,
    admitted,
    rejected,
    rejectionRate: traffic > 0 ? (rejected / traffic) * 100 : 0,
    peakRate,
    multiplier,
    fixedWindowCapacity: limit * WINDOW_SECONDS,
  };
}

function algorithmName(algorithm: number): string {
  if (algorithm === 1) return "Fixed window";
  if (algorithm === 2) return "Sliding window";
  return "Token bucket";
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.4);
  const seeds: [string, number, number][] = [
    ["burst-multiplier", values.multiplier, 0.02],
    ["admitted-rate", values.admitted, values.limit * 0.02],
    ["rejection-rate", values.rejectionRate, 0.5],
    ["effective-peak-rate", values.peakRate, values.limit * 0.02],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 1.9) * amplitude),
    );
  }
  frame.series["admitted-trace"] = Array.from({ length: 24 }, () => values.admitted);
}

function buildFrame(values: Computed, seed: number): SimFrame {
  const limiterHealth = healthFor(values.multiplier, 1.15, 1.5);
  const backendHealth = healthFor(values.rejectionRate, 60, 85);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client fleet",
        kind: "client",
        health: "ok",
        throughput: values.traffic,
        sublabel: `${Math.round(values.traffic).toLocaleString()} rps offered`,
        meta: { view: "flow" },
      },
      {
        id: "limiter",
        label: "Rate limiter",
        kind: "lb",
        health: limiterHealth,
        utilization: clamp(values.peakRate / Math.max(1, values.limit * 2)),
        throughput: values.admitted,
        sublabel: `${algorithmName(values.algorithm)} at ${Math.round(values.limit).toLocaleString()} rps`,
        detail: `Peak ${Math.round(values.peakRate).toLocaleString()} rps, or ${values.multiplier.toFixed(2)}× the configured limit. ${Math.round(values.rejectionRate)}% of offered traffic is rejected.`,
        meta: { view: "flow", multiplier: values.multiplier },
      },
      {
        id: "backend",
        label: "Backend service",
        kind: "service",
        health: backendHealth,
        utilization: clamp(values.admitted / Math.max(1, values.limit)),
        throughput: values.admitted,
        sublabel: `${Math.round(values.admitted).toLocaleString()} rps admitted`,
        meta: { view: "flow" },
      },
      {
        id: "rejected",
        label: "Rejected traffic",
        kind: "external",
        health: values.rejectionRate >= 45 ? "crit" : values.rejectionRate >= 25 ? "warn" : "ok",
        throughput: values.rejected,
        sublabel: `${Math.round(values.rejectionRate)}% of arrivals`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-limiter", "client", "limiter", values.traffic / 20_000, limiterHealth),
      edge("limiter-backend", "limiter", "backend", values.admitted / 20_000, backendHealth),
      edge("limiter-rejected", "limiter", "rejected", values.rejected / 20_000, "warn"),
    ],
    metrics: [
      metric("burst-multiplier", "Burst multiplier", values.multiplier, "×", 1.15, 1.5, "number"),
      metric("admitted-rate", "Admitted rate", values.admitted, " rps", undefined, undefined, "rps"),
      metric("rejection-rate", "Rejection rate", values.rejectionRate, "%", 25, 45, "percent"),
      metric("effective-peak-rate", "Peak rolling-window rate", values.peakRate, " rps", values.limit * 1.15, values.limit * 1.5, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      algorithm: values.algorithm,
      tokens: values.burst,
      windowUsed: 0,
    },
    summary: `${algorithmName(values.algorithm)}: ${values.multiplier.toFixed(2)}× the configured rate at the boundary; ${Math.round(values.rejectionRate)}% rejected.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "burst-multiplier",
    metricId: "burst-multiplier",
    warn: 1.15,
    crit: 1.5,
    title: "The limiter admits more than its configured rate",
    cause:
      "A fixed window counts requests per calendar window. Traffic that arrives at the end of one window and the start of the next is counted against two separate allowances, so a short interval can carry up to twice the limit. A token bucket does the same when its bucket is larger than the intended burst.",
    fix:
      "Use a token bucket with a bucket sized to the burst you actually intend, or a sliding-window counter that evaluates the trailing interval. Do not fix a boundary artifact by raising the sustained limit.",
    checkFirst: [
      "Compare admitted rate with the configured limit over a rolling interval, not per calendar window.",
      "Check whether client traffic clusters around window boundaries.",
      "Check the bucket capacity: a large bucket is an unbounded exception in disguise.",
    ],
  },
  {
    id: "rejection-rate",
    metricId: "rejection-rate",
    warn: 25,
    crit: 45,
    title: "Too much traffic is being rejected",
    cause:
      "Offered traffic is above the enforced rate. Rejection is the correct outcome for excess traffic, but the volume determines whether clients see errors, retries, or a degraded product.",
    fix:
      "Decide whether the limit is wrong or the traffic is. Raise the limit only if the backend has capacity; otherwise shed earlier at the edge, return a clear 429 with a retry hint, and keep retries out of the same bucket.",
    checkFirst: [
      "Split rejection by client, route, and priority class.",
      "Check whether rejected requests are retried immediately.",
      "Compare the configured limit with the backend's measured safe rate.",
    ],
  },
];

function traceAdmitted(frame: SimFrame, p: Params, dt: number): { admitted: number; tokens: number; windowUsed: number } {
  const values = compute(p);
  const nextT = frame.t + dt;
  const phase = nextT % WINDOW_SECONDS;
  const inPulse = phase < 1 || phase > WINDOW_SECONDS - 1;
  const arrival = inPulse
    ? (values.concentration * values.traffic * WINDOW_SECONDS) / 2
    : (1 - values.concentration) * values.traffic;

  if (values.algorithm === 1) {
    const newWindow = Math.floor(nextT / WINDOW_SECONDS) !== Math.floor(frame.t / WINDOW_SECONDS);
    const used = newWindow ? 0 : Math.max(0, Number(frame.flags.windowUsed ?? 0));
    const admitted = Math.min(arrival * dt, Math.max(0, values.fixedWindowCapacity - used));
    return { admitted, tokens: 0, windowUsed: used + admitted };
  }
  if (values.algorithm === 0) {
    const tokens = Math.min(values.burst, Math.max(0, Number(frame.flags.tokens ?? values.burst)) + values.limit * dt);
    const admitted = Math.min(arrival * dt, tokens);
    return { admitted, tokens: tokens - admitted, windowUsed: 0 };
  }
  return { admitted: Math.min(arrival, values.limit) * dt, tokens: 0, windowUsed: 0 };
}

export const rateLimitModel: SimModel = {
  id: "foundations-rate-limiting",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(compute(defaults()), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const values = compute(p);
    const trace = traceAdmitted(frame, p, dt);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, tokens: trace.tokens, windowUsed: trace.windowUsed };
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, series]) => [key, [...series]]));
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    recordSeries(next, "admitted-trace", trace.admitted / Math.max(dt, 0.01));
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${algorithmName(values.algorithm)}: peak ${Math.round(values.peakRate).toLocaleString()} rps (${values.multiplier.toFixed(2)}×); ${Math.round(values.rejectionRate)}% rejected.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `${algorithmName(values.algorithm)} enforces ${Math.round(values.limit).toLocaleString()} rps over a ${WINDOW_SECONDS}s window, but its worst rolling interval reaches ${Math.round(values.peakRate).toLocaleString()} rps.`,
    );
    if (values.algorithm === 1 && values.concentration > 0.2) {
      items.push(
        `${Math.round(values.concentration * 100)}% of traffic arrives around the boundary. Two adjacent windows can each spend their full allowance, which is how the 2× burst appears.`,
      );
    }
    if (values.algorithm === 0) {
      items.push(
        `The bucket holds ${Math.round(values.burst).toLocaleString()} requests. A bucket larger than the burst you can absorb is not a safety limit; it is deferred overload.`,
      );
    }
    if (values.algorithm === 2) {
      items.push(
        "A sliding window evaluates the trailing interval, so it does not reset a full allowance at the calendar boundary. It still admits whatever the trailing interval allows.",
      );
    }
    items.push(
      `${Math.round(values.rejected).toLocaleString()} rps is rejected. Rejection is not a failure by itself; it is the limiter doing its job if the limit matches backend capacity.`,
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Near limit", tone: "warn" },
    { label: "Over limit", tone: "crit" },
    { label: "Rejected", tone: "info" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "1k rps against a 2k limit with a small bucket. Nothing queues or rejects.",
    tone: "ok",
    params: defaults({ algorithm: 0, trafficRps: 1_000, limitRps: 2_000, burstSize: 300, boundaryShare: 0 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "6k rps against 4k, with half the traffic at the window boundary. The fixed window drifts into warning.",
    tone: "warn",
    params: defaults({ algorithm: 1, trafficRps: 6_000, limitRps: 4_000, burstSize: 500, boundaryShare: 50 }),
  },
  {
    id: "failure",
    label: "Boundary burst",
    description: "8k rps against a 2k fixed window, fully concentrated at the boundary. The short interval carries twice the limit.",
    tone: "crit",
    params: defaults({ algorithm: 1, trafficRps: 8_000, limitRps: 2_000, burstSize: 500, boundaryShare: 100 }),
  },
  {
    id: "oversized-bucket",
    label: "Oversized bucket",
    description: "The same 8k load with a token bucket holding 20k requests. The algorithm changes; the burst does not.",
    tone: "crit",
    params: defaults({ algorithm: 0, trafficRps: 8_000, limitRps: 2_000, burstSize: 20_000, boundaryShare: 100 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A token bucket at 6k with a 500-request bucket admits the sustained rate and bounds the burst.",
    tone: "ok",
    params: defaults({ algorithm: 0, trafficRps: 6_000, limitRps: 6_000, burstSize: 500, boundaryShare: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-boundary-fix",
  title: "Predict what removes the boundary burst",
  simId: "rate-limiter",
  question:
    "A fixed-window limiter enforces 2k rps over ten seconds. Traffic arrives in two pulses around every window boundary. Which change bounds the short-interval rate without lowering the sustained limit?",
  prediction: {
    options: [
      { id: "raise-limit", label: "Raise the configured limit" },
      { id: "token-bucket", label: "Use a token bucket with a small bucket" },
      { id: "shorter-window", label: "Shorten the fixed window to one second" },
      { id: "retries", label: "Retry rejected requests with jitter" },
    ],
    correctOptionId: "token-bucket",
    explanation:
      "A token bucket refills at the sustained limit and can admit no more than the bucket capacity at once. A fixed window reseeds a full allowance at every boundary, so shortening the window changes the artifact's size but not its shape. Raising the limit makes the backend problem worse, and retries add load.",
  },
  setup: defaults({ algorithm: 1, trafficRps: 8_000, limitRps: 2_000, burstSize: 500, boundaryShare: 100 }),
  runFor: 20,
  observe: [
    "The burst multiplier reaches 2.00× even though admitted rate averages 2k rps.",
    "Rejection is about 75%: the limiter is enforcing an average, not a short-interval bound.",
    "The admitted trace shows two pulses per ten-second window, one at each boundary.",
    "A token bucket with a 500-request bucket holds the multiplier near 1.03× at the same load.",
  ],
  explain:
    "The fixed window has two independent allowances adjacent in time. Each can be spent at the boundary, so a rolling interval short enough to include both sees twice the configured capacity. The token bucket has one allowance that refills continuously; its maximum short-interval admission is the bucket capacity plus refill. The burst is bounded by a number the operator chose, not by where the clock happens to be.",
  fix: defaults({ algorithm: 0, trafficRps: 8_000, limitRps: 2_000, burstSize: 500, boundaryShare: 100 }),
  debrief:
    "The token bucket still rejects about 75% of the offered load because 8k rps genuinely exceeds 2k. What changed is the shape of what gets through: no boundary interval carries twice the limit. That protects the backend from a predictable spike while leaving the sustained policy unchanged. The cost is a bucket to size and monitor, and a burst allowance that must match downstream capacity.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A rate limiter decides which requests are allowed to proceed. It protects a backend, enforces a tenant quota, or keeps one client from consuming a shared service. The policy has two numbers: a sustained rate and a burst allowance. The algorithm decides how those numbers are enforced over time.",
  },
  {
    type: "p",
    text: "A token bucket holds up to a configured number of tokens. Tokens refill at the sustained rate, and each admitted request spends one. The bucket can empty during a burst and then refills smoothly. A fixed window counts requests in a calendar interval and resets the counter at the boundary. A sliding window evaluates the trailing interval, so the allowance does not reappear all at once.",
  },
  {
    type: "p",
    text: "The fixed window's failure is a time-boundary artifact. If the limit is 2,000 requests per ten seconds, a client can send 2,000 requests just before the boundary and another 2,000 just after it. Each window is individually compliant, but a short interval carries 4,000 requests. That is twice the intended rate, and the backend sees it as a spike.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Rate limiting belongs as close to the traffic source as the policy allows: at the edge, at an API gateway, or in a shared proxy in front of the service. Enforcing it inside every service instance multiplies the configured limit by the instance count unless the counter is shared. Enforcing it only at the database protects the database but lets excess work consume the service first.",
  },
  {
    type: "table",
    headers: ["Algorithm", "What it bounds", "Boundary behavior", "Cost"],
    rows: [
      ["Token bucket", "Sustained rate plus a chosen burst", "No reset spike; burst capped by bucket", "Bucket state per key; capacity tuning"],
      ["Fixed window", "Count per calendar interval", "Up to 2× across adjacent windows", "Simple counter; boundary spikes"],
      ["Sliding window", "Count over the trailing interval", "No full-allowance reset", "More state or approximation error"],
      ["Leaky bucket", "Output rate with a queue", "Smooths bursts by delaying them", "Adds latency; queue can fill"],
    ],
  },
  {
    type: "p",
    text: "This module models a ten-second window with illustrative rates from 500 to 20,000 rps. The numbers are teaching values, not a vendor quota. The shape is the lesson: a limiter that enforces an average can still admit a short burst, and the burst is what the backend feels.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Burst multiplier: peak admitted rate in a rolling window divided by the configured limit.",
      "Admitted and rejected rates: what got through and what the client was told to stop.",
      "Peak rolling-window rate in rps: the multiplier expressed in the units the backend sees.",
      "An admitted trace: the per-second shape, which makes the boundary pulse visible.",
      "Limiter and backend node states: the limiter can be healthy while its policy is not.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Boundary burst. Watch the admitted trace and the burst multiplier, not the average admitted rate. Run the experiment before revealing the explanation. Then apply Oversized bucket to see that the algorithm name alone does not bound a burst, and finish with Recovery.",
  },
  {
    type: "p",
    text: "The first question is not which algorithm is modern. It is what the backend can absorb in the worst second, and whether the limiter's burst allowance is smaller than that. A bucket sized to the queue's spare capacity is a safety limit. A bucket sized to the largest burst anyone has ever sent is a delayed outage.",
  },
  { type: "sim", simId: "rate-limiter" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The fixed window enforced 2k rps on average and still admitted 4k rps around the boundary. Each calendar window had its own allowance, and the traffic arrived where two allowances meet. The admitted trace showed two pulses per ten seconds; the average hid them. The backend received a predictable spike that the configured rate said could not happen.",
  },
  {
    type: "p",
    text: "The oversized token bucket repeated the failure with a different mechanism. A bucket holding 20,000 requests can admit 20,000 requests immediately, even though it refills at 2k rps. The algorithm was no longer a fixed window, but the burst allowance was still larger than the backend could absorb. The small bucket bounded the burst at roughly 1.03× and kept the sustained limit.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Gateway metrics: admitted, rejected, and throttled counts split by route, tenant, and status code.",
      "A rolling-window or short-interval rate, not only a one-minute average. A one-minute average hides a two-second spike.",
      "Backend saturation: queue depth, p99, and error rate at the moment the limiter reports compliance.",
      "Client behavior: 429 volume, retry rate, and whether retries land in the same bucket as new traffic.",
      "Bucket state where the implementation exposes it: available tokens, refill rate, and the largest observed burst.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the configured limit with the admitted rate over a rolling interval, not per calendar window. Check whether traffic clusters around window boundaries. Check the bucket capacity against the backend's spare queue. Then split rejection by tenant and route: a limiter can be globally correct and still starve one caller.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the backend's safe short-interval rate, not only its safe sustained rate.",
      "Choose a token bucket or sliding window if boundary spikes are unacceptable.",
      "Size the bucket to the burst the backend can absorb while other traffic is present.",
      "Return a clear rejection with a retry hint, and keep retries out of the same allowance.",
      "Load-test with boundary-concentrated traffic; uniform load will not reproduce the artifact.",
      "Alert on the rolling-window rate and backend saturation together, not on rejection count alone.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A small bucket bounds bursts but rejects traffic that a slightly larger bucket would have admitted; the right size depends on downstream queue capacity.",
      "A sliding window is more accurate than a fixed window and needs more state or an approximation with its own error.",
      "Distributed limiters trade accuracy for coordination: a local counter is fast but multiplies the limit by the instance count.",
      "Rejection is a product experience. A 429 with no retry guidance becomes a retry storm, and a retry storm is another burst.",
      "A limiter at the edge protects the backend but can reject traffic that would have been cheap; a limiter deeper in the path protects capacity but spends work before rejecting.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "fixed-window-burst",
    question:
      "A fixed-window limiter is set to 2,000 requests per ten seconds. The dashboard shows 2,000 admitted per window, yet the backend sees 4,000 requests in two seconds. How?",
    difficulty: 2,
    hints: [
      "The counter resets at the boundary.",
      "Two adjacent windows are two independent allowances.",
    ],
    answer:
      "The client sends up to the full allowance at the end of one window and another full allowance at the start of the next. Each window is individually within its limit, but the short interval spanning the boundary contains 4,000 requests. I would confirm it with a rolling-window rate or a per-second histogram, then replace the fixed window with a token bucket or a sliding-window counter. Raising the sustained limit would make the backend problem worse, and shortening the window only makes the spike narrower.",
    followUps: [
      "Would a one-second window fix it?",
      "How would you prove the spike exists from logs?",
      "What bucket size would you choose?",
    ],
    redFlags: [
      "Says the limiter is broken because the average is correct.",
      "Raises the limit to reduce rejections.",
      "Ignores the short-interval rate.",
    ],
    rubric: [
      "Explains the two-allowance boundary.",
      "Names a rolling-interval measurement.",
      "Chooses a token or sliding window.",
      "Ties bucket size to backend capacity.",
    ],
  },
  {
    id: "place-limiter",
    question:
      "Where do you place a rate limiter for a multi-tenant API, and what do you key it on?",
    difficulty: 3,
    hints: [
      "The protected resource and the fairness unit are different questions.",
      "A shared counter is a dependency too.",
    ],
    answer:
      "I would put a coarse limiter at the edge to absorb abusive volume before it consumes compute, keyed by tenant and route, and a second limiter at the service or dependency boundary for the resource that actually saturates. The edge limiter protects availability; the inner limiter protects the database or downstream quota. Keys must match the fairness unit: tenant, API key, user, or source address, with a documented fallback when the key is missing. A distributed counter adds a shared dependency and latency, so I would use a local token bucket with a periodic global sync if exactness is less important than availability, and measure the resulting overshoot.",
    followUps: [
      "What happens when the counter store is unavailable?",
      "How do you prevent one tenant from exhausting a shared pool?",
      "Would you limit before or after authentication?",
    ],
    redFlags: [
      "Places every limiter inside each service instance.",
      "Keys only on IP address for an authenticated API.",
      "Adds a synchronous counter call on the hot path without a fallback.",
    ],
    rubric: [
      "Separates edge protection from resource protection.",
      "Chooses a key that matches fairness.",
      "Names the shared-counter tradeoff.",
      "Defines behavior when the limiter store fails.",
    ],
  },
  {
    id: "distributed-limit",
    question:
      "A limiter uses an in-process token bucket in each of 12 instances and each is configured for 2,000 rps. What is the real limit, and how do you fix it?",
    difficulty: 3,
    hints: [
      "Each instance enforces its own configuration.",
      "A shared counter is a dependency on the hot path.",
    ],
    answer:
      "The fleet can admit up to 24,000 rps, because each instance enforces 2,000 independently. I would either move the policy to a shared edge limiter, divide the global budget across instances, or use a shared atomic counter with a local fallback. If I divide the budget, I need to account for autoscaling and instance churn; if I share a counter, I need to decide what happens when the counter store is slow or unavailable. I would keep a conservative local limit as the fallback and measure the overshoot, because a limiter that fails open can flatten the backend.",
    followUps: [
      "How does autoscaling change the per-instance budget?",
      "What does the limiter do when Redis is unavailable?",
      "Would you rather fail open or fail closed?",
    ],
    redFlags: [
      "Assumes the configured limit is global.",
      "Fails open without a bound.",
      "Adds a synchronous counter call with no timeout.",
    ],
    rubric: [
      "Multiplies the limit by the instance count.",
      "Chooses a global or partitioned budget.",
      "Defines the counter-store failure mode.",
      "Measures overshoot.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The backend's safe sustained and short-interval rates are measured and written down.",
      "The limiter algorithm and bucket size are documented per route or tenant.",
      "A rolling-window rate is dashboarded alongside the configured limit.",
      "Rejection responses include a retry hint and are excluded from immediate retries.",
      "A load test sends boundary-concentrated traffic, not only uniform traffic.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare admitted rate over a rolling interval with the configured limit.",
      "Check whether traffic clusters at window boundaries or follows a deploy or cron schedule.",
      "Check bucket capacity before blaming the algorithm.",
      "Split rejection by tenant and route to find starvation or a single abusive caller.",
      "Watch backend queue depth and p99 while the limiter reports compliance.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Re-run the boundary test at the new limit and bucket size.",
      "Reconcile the limiter policy with the backend's measured capacity.",
      "Review retry behavior and whether rejected work returned through another path.",
      "Document the burst allowance and the product behavior at the limit.",
    ],
  },
];

const references = [
  {
    title: "Scaling your API with rate limiters",
    url: "https://stripe.com/blog/rate-limiters",
    publisher: "Stripe",
    kind: "docs" as const,
    note: "Token bucket, leaky bucket, fixed window, and the boundary problem.",
  },
  {
    title: "Rate limiting rules",
    url: "https://developers.cloudflare.com/waf/rate-limiting-rules/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "Edge enforcement, counting periods, and burst handling.",
  },
  {
    title: "Handling overload",
    url: "https://sre.google/sre-book/handling-overload/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Client-side throttling and rejecting excess work.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "rate-limiter": {
      model: rateLimitModel,
      presets,
      instructions:
        "Start healthy, apply Boundary burst, and watch the admitted trace and burst multiplier. Compare Oversized bucket and Recovery. The average admitted rate can look correct while the short-interval rate is not.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The ten-second window and 20k rps ceiling are teaching values, not a vendor quota.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-queueing-knee",
    "traffic-waf-rate-limits",
    "reliability-load-shedding",
    "foundations-admission-control",
  ],
};
