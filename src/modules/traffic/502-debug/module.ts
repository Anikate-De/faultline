import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TARGET_COUNT = 3;
const MAX_REQUEST_RATE = 10_000;
const TARGET_RPS = 4_000;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 200,
    max: MAX_REQUEST_RATE,
    step: 100,
    value: 1_200,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second arriving at the load balancer. The 502 rate is a share of this traffic.",
    format: "rps" as const,
  },
  {
    id: "faultyTargets",
    label: "Faulty targets",
    min: 0,
    max: TARGET_COUNT,
    step: 1,
    value: 0,
    unit: " of 3",
    group: "Targets",
    help: "Targets carrying the injected request-path fault. They keep passing the shallow health check, so the ALB keeps sending them traffic.",
    format: "count" as const,
  },
  {
    id: "faultMode",
    label: "Injected target fault",
    min: 0,
    max: 3,
    step: 1,
    value: 1,
    unit: "",
    group: "Targets",
    help: "0 none, 1 malformed response, 2 connection reset, 3 TLS handshake failure. Each cause produces an ELB-generated 502 when the response is not valid.",
    format: "count" as const,
  },
  {
    id: "faultShare",
    label: "Fault share",
    min: 0,
    max: 100,
    step: 5,
    value: 30,
    unit: "%",
    group: "Targets",
    help: "Share of requests to a faulty target that reach the fault. For the TLS mode, treat it as the share that opens a new backend connection.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sourceLabel(mode: number, active: boolean): string {
  if (!active) return "no active target fault";
  if (mode === 1) return "malformed target response";
  if (mode === 2) return "target connection reset";
  if (mode === 3) return "TLS handshake failure";
  return "no active target fault";
}

interface Demand {
  requestRate: number;
  faultyTargets: number;
  faultMode: number;
  faultShare: number;
  faultActive: boolean;
  failedRps: number;
  errorRate: number;
  acceptedRps: number;
  p99: number;
  source: string;
}

function demand(p: Params): Demand {
  const requestRate = Math.max(1, num(p, "requestRate", 1_200));
  const faultyTargets = Math.min(
    TARGET_COUNT,
    Math.max(0, Math.round(num(p, "faultyTargets", 0))),
  );
  const faultMode = Math.min(3, Math.max(0, Math.round(num(p, "faultMode", 1))));
  const faultShare = clamp(num(p, "faultShare", 30) / 100, 0, 1);
  const faultActive = faultMode !== 0 && faultyTargets > 0 && faultShare > 0;
  const failedRps = faultActive
    ? requestRate * (faultyTargets / TARGET_COUNT) * faultShare
    : 0;
  const errorRate = (failedRps / requestRate) * 100;
  const p99 = 14 + (faultMode === 3 ? 18 : 0) + (requestRate / MAX_REQUEST_RATE) * 3;
  return {
    requestRate,
    faultyTargets,
    faultMode,
    faultShare,
    faultActive,
    failedRps,
    errorRate,
    acceptedRps: requestRate - failedRps,
    p99,
    source: sourceLabel(faultMode, faultActive),
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = demand(p);
  const edgeHealth = d.errorRate >= 5 ? "crit" : d.errorRate >= 1 ? "warn" : "ok";
  const targets: SimNode[] = Array.from({ length: TARGET_COUNT }, (_, index) => {
    const faulty = d.faultActive && index < d.faultyTargets;
    const throughput = d.requestRate / TARGET_COUNT;
    return {
      id: `target-${index + 1}`,
      label: `Target ${String.fromCharCode(65 + index)}`,
      kind: "service",
      health: "ok",
      utilization: clamp(throughput / TARGET_RPS),
      throughput,
      sublabel: faulty ? `check passing · ${Math.round(d.faultShare * 100)}% bad` : "check passing",
      detail: faulty
        ? `GET /healthz returns 200, so this target stays in service. The request path is returning ${d.source}. The ALB records a 502 with no valid target status code; the target's own 5xx counter does not move.`
        : "The health check and the request path both return a valid response.",
      meta: { view: "flow", fault: faulty ? d.source : "none" },
    };
  });

  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: edgeHealth,
        throughput: d.requestRate,
        sublabel: `${formatCount(d.failedRps)} 502s/s`,
        detail: `${d.errorRate.toFixed(1)}% of requests receive a 502. The target may still be running and passing its health check.`,
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "Application Load Balancer",
        kind: "lb",
        health: edgeHealth,
        utilization: clamp(d.requestRate / MAX_REQUEST_RATE),
        throughput: d.acceptedRps,
        sublabel: `ELB 502 · ${formatCount(d.failedRps)}/s`,
        detail: `The ALB could not get a valid response from a target. Active source: ${d.source}. ${formatCount(d.acceptedRps)} requests/s still receive a valid response.`,
        meta: { view: "flow", source: d.source },
      },
      ...targets,
    ],
    edges: [
      edge("client-alb", "client", "alb", d.requestRate / MAX_REQUEST_RATE, edgeHealth),
      ...targets.map((target, index) =>
        edge(
          `alb-${target.id}`,
          "alb",
          target.id,
          d.requestRate / TARGET_COUNT / TARGET_RPS,
          d.faultActive && index < d.faultyTargets ? "crit" : "ok",
        ),
      ),
    ],
    metrics: [
      metric("error-rate", "502 rate", d.errorRate, "%", 1, 5, "percent"),
      metric("502-rate", "ELB-generated 502", d.failedRps, " /s", 10, 100, "rps"),
      metric("healthy-targets", "Healthy targets", TARGET_COUNT, " targets", undefined, undefined, "count"),
      metric("target-5xx", "Target-generated 5xx", 0, " /s", undefined, undefined, "rps"),
      metric("p99", "ALB p99", d.p99, " ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, source: d.source },
    summary: `${formatCount(d.failedRps)} 502s/s (${d.errorRate.toFixed(1)}% of requests); ${TARGET_COUNT} of ${TARGET_COUNT} targets pass health checks; target-generated 5xx is 0/s; source: ${d.source}.`,
  };
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "502 rate crossed the threshold",
    cause:
      "The load balancer could not get a valid HTTP response from a target. Malformed responses, a target connection reset, and a TLS handshake failure all surface as an ALB-generated 502, even when the target still passes its health check.",
    fix:
      "Find the source before changing capacity: compare ELB 502 with target 5xx, then read the target response and the ALB-to-target protocol, TLS, and keepalive configuration. Roll back the response change or align the protocol and keepalive.",
    checkFirst: [
      "Compare HTTPCode_ELB_502_Count with HTTPCode_Target_5XX_Count for the same window.",
      "Read access logs for elb_status_code 502, target_status_code, target:port, and the processing-time fields.",
      "Check whether the failing requests share a route, a target group, or a recent deploy.",
    ],
  },
  {
    id: "502-rate",
    metricId: "502-rate",
    warn: 10,
    crit: 100,
    title: "ELB-generated 502 volume is high",
    cause:
      "Enough requests are failing at the edge to consume the error budget, even if the percentage looks tolerable at high traffic. The failing requests never produce a valid target status code.",
    fix:
      "Use target:port in the access logs to identify the affected targets, then fix or remove them. Do not add target capacity to a fleet that is returning invalid responses.",
    checkFirst: [
      "Group failures by target:port and Availability Zone.",
      "Compare the first failing timestamp with deploys, certificate changes, and target-group changes.",
      "Check target logs for completed handlers, truncated bodies, or closed keepalive connections.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const badGatewayModel: SimModel = {
  id: "traffic-502-debug",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const d = demand(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, seed);
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: JSON.stringify(p) };
    next.events = [...frame.events].slice(-60);
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
    );
    const jitter = 1 + rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value * jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (d.errorRate >= 5 && next.flags.faultEvent !== 1) {
      pushEvent(next, {
        id: "fault-passes-health-check",
        at: frame.t,
        severity: "crit",
        title: "Targets pass health checks while the ALB returns 502s",
        detail: `${formatCount(d.failedRps)} requests/s fail with a 502 from ${d.source}. All ${TARGET_COUNT} targets report healthy because the shallow check does not exercise the failing request path. Target-generated 5xx is 0/s.`,
        nodeId: "alb",
        metricId: "error-rate",
      });
      next.flags.faultEvent = 1;
    }
    if (d.errorRate < 5) next.flags.faultEvent = 0;
    next.summary = `${formatCount(d.failedRps)} 502s/s (${d.errorRate.toFixed(1)}% of requests); ${TARGET_COUNT} of ${TARGET_COUNT} targets pass health checks; target-generated 5xx is 0/s; source: ${d.source}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = demand(p);
    const items: string[] = [];
    items.push(
      `${formatCount(d.failedRps)} requests/s fail with a 502 (${d.errorRate.toFixed(1)}% of traffic) across ${d.faultyTargets} of ${TARGET_COUNT} targets.`,
    );
    items.push(
      "All targets keep passing the shallow health check, so HealthyHostCount and the target dashboard stay green while the request path fails.",
    );
    items.push(
      `Active source: ${d.source}. An ALB-generated 502 has elb_status_code 502 and no valid target_status_code; a target-generated 502 would also increment target 5xx.`,
    );
    if (d.faultMode === 2) {
      items.push(
        "A target keepalive shorter than the ALB idle timeout can close a connection just as the ALB reuses it. Align the idle values before adding capacity.",
      );
    }
    if (d.faultMode === 3) {
      items.push(
        "A TLS handshake failure between the ALB and target is an edge 502. A TCP health check can still pass because it never negotiates TLS.",
      );
    }
    if (!d.faultActive) {
      items.push("No target fault is active; the 502 path is clear.");
    }
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
    description: "Three healthy targets and a light request rate. No target fault is active.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description: "High request volume with valid responses from every target. The edge has no 502 source.",
    tone: "warn",
    params: defaults({ requestRate: 8_000 }),
  },
  {
    id: "failure",
    label: "Malformed responses",
    description: "Two targets return a malformed response on a share of requests. Health checks stay green and 502s rise.",
    tone: "crit",
    params: defaults({
      requestRate: 3_000,
      faultyTargets: 2,
      faultMode: 1,
      faultShare: 40,
    }),
  },
  {
    id: "reset",
    label: "Connection reset",
    description: "One target closes keepalive connections early. The ALB records 502s while the health check still passes.",
    tone: "crit",
    params: defaults({
      requestRate: 3_000,
      faultyTargets: 1,
      faultMode: 2,
      faultShare: 100,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The bad target release is rolled back. The same traffic now receives valid responses.",
    tone: "ok",
    params: defaults({
      requestRate: 3_000,
      faultyTargets: 0,
      faultMode: 1,
      faultShare: 0,
    }),
  },
];

const experiment: Experiment = {
  id: "prove-502-source",
  title: "Prove which side generated the 502",
  simId: "502-debug",
  question:
    "Users get 502s. The target dashboard is green, the handler logs look normal, and no target 5xx appears. Which observation proves the load balancer generated the 502?",
  prediction: {
    options: [
      {
        id: "elb-only",
        label:
          "HTTPCode_ELB_502_Count rises while HTTPCode_Target_5XX_Count stays flat, and the access log shows elb_status_code 502 with target_status_code -.",
      },
      {
        id: "target-5xx",
        label:
          "HTTPCode_Target_5XX_Count rises, which means the target generated the 502.",
      },
      {
        id: "healthy-zero",
        label: "HealthyHostCount drops to zero, which removes every target from service.",
      },
      {
        id: "target-time",
        label: "TargetResponseTime exceeds the ALB idle timeout, which produces the 502.",
      },
    ],
    correctOptionId: "elb-only",
    explanation:
      "The ELB and target 5xx counters are separate. When the ALB cannot obtain a valid response, it records HTTPCode_ELB_502_Count and the access log has elb_status_code 502 with no valid target_status_code. A target that itself returns 502 appears in HTTPCode_Target_5XX_Count and has target_status_code 502. HealthyHostCount can stay at three because the shallow health check still passes. TargetResponseTime is a latency signal; excess latency is associated with timeouts, not this malformed-response 502.",
  },
  setup: defaults({
    requestRate: 3_000,
    faultyTargets: 2,
    faultMode: 1,
    faultShare: 40,
  }),
  runFor: 20,
  observe: [
    "The 502 rate settles near 26.7% of requests, about 800 502s/s.",
    "All three targets remain healthy and target-generated 5xx stays at 0/s.",
    "The two faulty targets show a failing request edge while their node health stays green.",
    "Access-log fields show elb_status_code 502 and no valid target_status_code for the failures.",
  ],
  explain:
    "The target still accepts requests and the handler completes, but the bytes it returns are not a valid HTTP response. The ALB rejects the response before a valid status exists, so the error is counted at the edge. A health check that only asks /healthz for 200 never exercises the response serialization or header path that is broken. That is why the target dashboard and the client experience disagree.",
  fix: defaults({
    requestRate: 3_000,
    faultyTargets: 0,
    faultMode: 1,
    faultShare: 40,
  }),
  debrief:
    "Rolling back the response change returns the 502 rate to zero at the same traffic. The useful sequence was source first, target second: the ELB and target counters separated the edge from the application, then target:port narrowed the fleet. Adding targets would have multiplied the same malformed response across more capacity.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A 502 Bad Gateway means a gateway or proxy did not receive a valid response from the upstream it was trying to reach. On an Application Load Balancer (ALB), that upstream is a registered target. The target can be running, passing its health check, and still produce a 502 if it returns a malformed response, closes the connection at the wrong moment, or fails the Transport Layer Security (TLS) handshake with the load balancer.",
  },
  {
    type: "p",
    text: "AWS lists several concrete causes: a TCP reset while connecting, a target that closes with RST or FIN while a request is outstanding, a response with invalid headers or a response header larger than 32 KB, a TLS handshake error between the load balancer and target, and a deregistration delay that expires during an in-flight request. The first diagnostic question is not which cause sounds likely. It is whether the 502 came from the edge or from the target.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is client, ALB, target. The health check is a separate path to the same target, usually a different URL or a simpler request. A shallow health check proves only that the process answers that one request. It does not prove that the response path used by real traffic is valid. That gap is the reason a target can be green in the console while users see 502s.",
  },
  {
    type: "table",
    headers: ["Code", "What it means", "First split"],
    rows: [
      ["502", "The gateway could not obtain a valid response from the target. The target may still be healthy.", "Compare ELB 502 with target 5xx; read target_status_code."],
      ["503", "No target can receive traffic, or a target is rejecting with 503.", "Compare ELB 503 with target 5xx; check registration and healthy count."],
      ["504", "A gateway timer expired before the upstream responded.", "Compare elapsed time with the idle timeout; read target_processing_time."],
    ],
  },
  {
    type: "p",
    text: "The first split is the same for all three codes: read the status generated by the load balancer separately from the status generated by the target. In CloudWatch that is HTTPCode_ELB_5XX_Count versus HTTPCode_Target_5XX_Count. In access logs it is elb_status_code versus target_status_code. A dash in target_status_code means the target did not send a valid response; it does not by itself explain why.",
  },
  {
    type: "compare",
    leftTitle: "Health check path",
    rightTitle: "Request path",
    rows: [
      { label: "Request", left: "GET /healthz on a fixed interval", right: "The real route, headers, body, and status" },
      { label: "What it proves", left: "The process is reachable and answers one simple request", right: "End-to-end response validity for user traffic" },
      { label: "Blind spot", left: "Serialization, compression, streaming, and protocol edge cases", right: "Slow or malformed responses that the target still logs as completed" },
      { label: "Failure it misses", left: "A malformed response only on /export or under load", right: "A health check that is too shallow to catch a broken dependency" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A 502 rate and an absolute 502 count, separated from target-generated 5xx.",
      "Three target cards that report health-check status separately from request-path errors.",
      "An injected fault selector for malformed responses, connection resets, and TLS handshake failures.",
      "An incident event and threshold markers that fire while the targets still show healthy.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Malformed responses. Compare the ELB 502 count with target 5xx before changing any slider. Apply Connection reset and then the TLS mode by editing the fault selector to see the same 502 with different evidence. Finish with Recovery and confirm both counters return to zero.",
  },
  { type: "sim", simId: "502-debug" },
  { type: "experiment", experimentId: "prove-502-source" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Two targets returned a malformed response on 40% of their requests. The ALB could not parse a valid status, so it generated a 502 before the target's response became an HTTP result. The targets stayed in service because the shallow health check kept returning 200. Target-generated 5xx stayed at zero, which is the signal that separates this from an application that chose to return 502.",
  },
  {
    type: "p",
    text: "At 3,000 requests/s, the failure produced about 800 502s/s, or 26.7% of traffic. The total 502 count and the percentage told different parts of the story: the percentage described user impact, while the count described how much retry and error-budget pressure the edge was absorbing.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CloudWatch ALB: HTTPCode_ELB_502_Count, HTTPCode_Target_5XX_Count, TargetConnectionErrorCount, HealthyHostCount, and TargetResponseTime, split by target group and Availability Zone.",
      "Access logs: elb_status_code 502, target_status_code, target:port, request_processing_time, target_processing_time, and response_processing_time. A target that never sent a valid response has no target status.",
      "Target application logs: completed handlers, truncated or compressed bodies, header serialization errors, and connection close events. A normal handler log does not prove the bytes on the wire were valid.",
      "TLS and protocol state: the target group protocol and port, the certificate chain and ciphers, and whether the health check uses TCP, HTTP, or HTTPS.",
      "Envoy or service-mesh access logs, when present: response flags such as UPE for an upstream protocol error and UC for an upstream connection termination.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Split ELB 502 from target 5xx, then read target_status_code and target:port. If the edge generated the 502, the target's health check is not evidence that the request path is valid. Check the failing route, the response headers and body, the ALB-to-target protocol and TLS settings, and the keepalive values before you add capacity.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the source: ELB 502 with no target status code means the edge could not obtain a valid response; target 5xx means the target generated the error.",
      "Narrow the blast radius with target:port, route, and deploy timestamp. One bad target version is a different fix from a fleet-wide protocol change.",
      "For a malformed response, capture the failing response at the target and validate the status line, headers, content length, and transfer encoding.",
      "For a reset, compare the target keepalive with the ALB idle timeout and check for process exits or connection-pool eviction.",
      "For TLS, verify the target group protocol, port, certificate chain, SNI, and cipher policy, and confirm that the health check actually negotiates TLS.",
      "Roll back the change or remove the bad targets, then verify both ELB 502 and target 5xx return to zero at the original traffic.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A deeper health check catches broken response paths sooner, but it also consumes more target capacity and can remove an entire fleet during a shared dependency failure.",
      "Removing a faulty target stops the 502s but reduces capacity; if the remaining targets cannot absorb the traffic, the symptom can move to 503 or 504.",
      "Retries can hide a small 502 rate from users while multiplying load on the targets that are already failing. Bound retries with a budget and jitter.",
      "Disabling TLS verification or loosening the cipher policy may stop the handshake failure, but it weakens the trust boundary and is not a production fix.",
      "Adding targets does not fix a malformed response. It only spreads the same bad response across more capacity.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "first-look-502",
    question:
      "Users report 502s. The target dashboard shows healthy and no target 5xx. Where do you look first?",
    difficulty: 2,
    hints: [
      "Separate the status generated by the load balancer from the status generated by the target.",
      "A health check is one request, not the whole request path.",
    ],
    answer:
      "I would split the source before touching capacity. I compare HTTPCode_ELB_502_Count with HTTPCode_Target_5XX_Count for the same window, then read the access logs for elb_status_code, target_status_code, target:port, and the processing-time fields. If the ELB count is rising and target 5xx is flat, the ALB could not obtain a valid response. I would then narrow by target and route and check the response bytes, the ALB-to-target protocol and TLS settings, and the keepalive values. A healthy host count only means the health check passed; it does not prove the failing request path is valid.",
    followUps: [
      "What would make you suspect the target generated the 502 instead?",
      "Which access-log field tells you the target never sent a valid response?",
      "How would a recent TLS change alter your first check?",
    ],
    redFlags: [
      "Starts by adding targets or restarting every task.",
      "Treats a green health check as proof that the request path works.",
      "Reads only the client error rate and never splits ELB from target 5xx.",
    ],
    rubric: [
      "Names the ELB-versus-target split.",
      "Reads target_status_code and target:port.",
      "Considers protocol, TLS, and keepalive.",
      "States what evidence would change the diagnosis.",
    ],
  },
  {
    id: "health-check-blind-spot",
    question:
      "A target passes its health check but every request to /export returns 502. How can both be true?",
    difficulty: 2,
    hints: [
      "The health check and the failing route are different code paths.",
      "A malformed response can still come from a process that answers /healthz.",
    ],
    answer:
      "The health check proves only that the process answered the check request. If /healthz returns a small static 200, it never exercises the export serializer, compression, streaming, or header-building path that is broken. The target can log a completed handler while the bytes it writes are not a valid HTTP response, so the ALB generates a 502 and the target's own 5xx counter stays flat. I would reproduce /export directly against one target, capture the response, and compare it with the route's expected headers. The fix is in the response path, not in target count.",
    followUps: [
      "Would you make the health check call /export?",
      "What does a deeper check risk during a shared dependency failure?",
      "How would you catch this before the next deploy?",
    ],
    redFlags: [
      "Assumes the health check covers every route.",
      "Raises the health check threshold without finding the bad response.",
      "Adds targets to absorb the failing route.",
    ],
    rubric: [
      "Explains the health-check blind spot.",
      "Distinguishes completed handler from valid wire response.",
      "Proposes a targeted reproduction.",
      "Names the fix location.",
    ],
  },
  {
    id: "tls-502",
    question:
      "After a target TLS upgrade, 502s start but only on new backend connections. What is your hypothesis and first check?",
    difficulty: 3,
    hints: [
      "The ALB terminates the client TLS session and opens a separate connection to the target.",
      "A TCP health check never negotiates TLS.",
    ],
    answer:
      "I would suspect the ALB-to-target TLS handshake, not the client-facing certificate. The target group protocol and port, the target certificate chain, the SNI value, and the cipher or security-policy compatibility are the first checks. If the health check is TCP, it can keep passing because it only proves the port is open. I would compare the first 502 timestamp with the target certificate or cipher change, test the handshake from a host in the load balancer's network, and check the ALB access log target:port and timing fields. The immediate mitigation is to roll back the target TLS change or align the protocol and cipher policy.",
    followUps: [
      "Where would you terminate TLS if the target must also be encrypted?",
      "How do you prove the failure is on the backend handshake rather than the client handshake?",
      "What would you change in the health check after the incident?",
    ],
    redFlags: [
      "Replaces the client-facing certificate first.",
      "Assumes a TCP health check validates TLS.",
      "Disables certificate verification as the permanent fix.",
    ],
    rubric: [
      "Separates client TLS from backend TLS.",
      "Names certificate, SNI, protocol, and cipher checks.",
      "Uses the access log and a direct handshake test.",
      "States a safe mitigation.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards separate HTTPCode_ELB_502_Count from HTTPCode_Target_5XX_Count and show HealthyHostCount.",
      "Access logging is enabled, and the team can query elb_status_code, target_status_code, and target:port.",
      "The target keepalive is documented and is longer than the ALB idle timeout.",
      "The target group protocol, port, certificate chain, and health check protocol are recorded.",
      "A deploy marker or version tag is visible on the same timeline as the 5xx metrics.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Split the source before changing capacity or restarting targets.",
      "Narrow by target:port, route, Availability Zone, and first failing timestamp.",
      "Check whether the health check exercises the failing route or only a shallow path.",
      "Capture a failing response or backend handshake before the evidence rolls off.",
      "Bound retries so a small 502 rate does not become a retry storm.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Roll back or fix the response, protocol, TLS, or keepalive change and verify both counters at peak.",
      "Add a synthetic check for the route that failed, not only for process liveness.",
      "Document which health check blind spot allowed the target to stay in service.",
      "Add a deploy gate that compares ELB 502 with target 5xx for the new version.",
    ],
  },
];

const references = [
  {
    title: "Troubleshoot your Application Load Balancers: HTTP 502",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html#http-502-issues",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The documented 502 causes, including malformed responses, resets, keepalive, and backend TLS handshake failures.",
  },
  {
    title: "How do I troubleshoot Application Load Balancer HTTP 502 errors?",
    url: "https://repost.aws/knowledge-center/elb-alb-troubleshoot-502-errors",
    publisher: "AWS re:Post",
    kind: "docs" as const,
    note: "The ELB-versus-target metric split and access-log fields for locating the source.",
  },
  {
    title: "Envoy substitution formatter: response flags",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/advanced/substitution_formatter",
    publisher: "Envoy",
    kind: "docs" as const,
    note: "Response flags UPE, UC, UF, and UT for proxy access logs. Envoy mappings are not identical to ALB status codes.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "502-debug": {
      model: badGatewayModel,
      presets,
      instructions:
        "Start Healthy, then apply Malformed responses. Compare ELB 502 with target 5xx before changing the fault selector. Try Connection reset, then Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Target count, fault share, request rates, and p99 values are teaching values. AWS documents the 502 causes and the ELB/target metric split, not these exact rates. The health check is assumed to be a shallow path that does not exercise the failing route.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-alb-health-checks",
    "traffic-keepalive-idle-timeout",
    "traffic-503-debug",
    "traffic-504-debug",
  ],
};
