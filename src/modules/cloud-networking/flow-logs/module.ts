import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "logs",
    label: "Flow logs enabled",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Logging",
    help: "1 records flows at the destination network interface. 0 removes the evidence, not the traffic.",
    format: "count" as const,
  },
  {
    id: "flows",
    label: "Offered flows",
    min: 100,
    max: 5_000,
    step: 100,
    value: 1_200,
    unit: " flows/min",
    group: "Traffic",
    help: "Flow records per minute for the tested connection. A flow is aggregated over an interval, not one packet.",
    format: "rps" as const,
  },
  {
    id: "dropLayer",
    label: "Drop point",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Path",
    help: "0 allows the flow. 1 drops at the destination security group. 2 drops at the subnet network ACL.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  logs: boolean;
  flows: number;
  dropLayer: number;
  accepted: number;
  rejected: number;
  observed: number;
  rejectedRate: number;
  evidenceGap: number;
  sgHealth: Health;
  naclHealth: Health;
  appHealth: Health;
}

function compute(p: Params): Computed {
  const logs = num(p, "logs", 1) >= 0.5;
  const flows = Math.max(1, num(p, "flows", 1_200));
  const dropLayer = clamp(Math.round(num(p, "dropLayer", 0)), 0, 2);
  const rejected = dropLayer === 0 ? 0 : flows;
  const accepted = dropLayer === 0 ? flows : 0;
  const observed = logs ? flows : 0;
  const rejectedRate = (rejected / flows) * 100;
  const evidenceGap = logs ? 0 : 100;
  return {
    logs,
    flows,
    dropLayer,
    accepted,
    rejected,
    observed,
    rejectedRate,
    evidenceGap,
    sgHealth: dropLayer === 1 ? "crit" : "ok",
    naclHealth: dropLayer === 2 ? "crit" : "ok",
    appHealth: rejected > 0 ? "crit" : "ok",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatPercent(value: number): string {
  return value >= 99.95 ? "100" : value.toFixed(1);
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const rows: [string, number, number][] = [
    ["rejected", values.rejectedRate, 0],
    ["evidence-gap", values.evidenceGap, 0],
    ["accepted", (values.accepted / values.flows) * 100, 0],
    ["observed", values.observed, 6],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) => {
      const wave = Math.sin((index + (seed % 6)) / 2.6) * amplitude;
      return Math.max(0, value + wave);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const dropLabel = values.dropLayer === 1 ? "security group" : values.dropLayer === 2 ? "network ACL" : "none";
  const recordAction = values.dropLayer === 0 ? "ACCEPT" : "REJECT";
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "client",
        kind: "client",
        health: "ok",
        sublabel: `${formatCount(values.flows)} flows/min`,
        detail: "The client sees a timeout or a connection failure. That symptom does not say where the packet stopped.",
        meta: { view: "flow" },
      },
      {
        id: "nacl",
        label: "subnet network ACL",
        kind: "mesh",
        health: values.naclHealth,
        sublabel: values.dropLayer === 2 ? "deny 443" : "allow 443",
        detail: values.dropLayer === 2
          ? "The subnet ACL denies the port. The flow log may show a REJECT record at the ENI, but the ACL rule and the return direction are the evidence to check."
          : "The ACL allows the port in both directions. ACLs are stateless, so the return path is a separate rule.",
        meta: { view: "flow" },
      },
      {
        id: "sg",
        label: "security group",
        kind: "mesh",
        health: values.sgHealth,
        sublabel: values.dropLayer === 1 ? "no inbound 443" : "allow from client",
        detail: values.dropLayer === 1
          ? "The security group has no rule allowing the client on port 443. The ENI records a REJECT for the request."
          : "The security group allows the client on port 443. A stateful rule covers the response.",
        meta: { view: "flow" },
      },
      {
        id: "eni",
        label: "app ENI · flow log",
        kind: "external",
        health: values.logs ? "ok" : "down",
        sublabel: values.logs ? `${recordAction} · ${formatCount(values.observed)} records/min` : "logging disabled",
        detail: values.logs
          ? `Records show the five-tuple, action, direction, bytes, and timestamps. This state would show ${recordAction}. Payload and HTTP status are not in the record.`
          : "No records are produced. The absence of a record is not proof that the packet never arrived; it may be a missing log subscription.",
        meta: { view: "flow", action: recordAction },
      },
      {
        id: "app",
        label: "orders-api",
        kind: "service",
        health: values.appHealth,
        sublabel: values.accepted > 0 ? "receives the flow" : "never receives the flow",
        detail: values.accepted > 0
          ? "The accepted flow reaches the application. A timeout after this point is an application, listener, or response-path problem."
          : "The flow never reaches the application. The rejection happened at the layer named by the flow log and the rules.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-nacl", "client", "nacl", 1, values.naclHealth),
      edge("nacl-sg", "nacl", "sg", values.dropLayer === 2 ? 0 : 1, values.sgHealth),
      edge("sg-eni", "sg", "eni", values.dropLayer === 1 ? 0 : 1, values.sgHealth),
      edge("eni-app", "eni", "app", values.accepted > 0 ? 1 : 0, values.appHealth),
    ],
    metrics: [
      metric("rejected", "Rejected flows", values.rejectedRate, "%", 0.5, 2, "percent"),
      metric("evidence-gap", "Evidence gap", values.evidenceGap, "%", 1, 50, "percent"),
      metric("accepted", "Accepted flows", (values.accepted / values.flows) * 100, "%", undefined, undefined, "percent"),
      metric("observed", "Flow records", values.observed, " records/min", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: values.logs
      ? `${recordAction} at ${dropLabel}; ${formatCount(values.observed)} records/min; ${formatPercent(
          values.rejectedRate,
        )}% rejected.`
      : `Flow logs disabled; ${formatCount(values.flows)} flows/min unfilmed; drop point ${dropLabel}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "rejected",
    metricId: "rejected",
    warn: 0.5,
    crit: 2,
    title: "Flows are being rejected before the application",
    cause:
      "A security group or network ACL rule denies the tested traffic. The flow log action is REJECT, but the rule that produced it is in the layer named by the path.",
    fix:
      "Read the rejected flow's five-tuple, then check the security group and both directions of the network ACL. Add the narrowest rule that allows the intended source and port.",
    checkFirst: [
      "Read the flow record's source, destination, ports, protocol, action, and direction.",
      "Check the security group inbound rule for the destination ENI.",
      "Check both directions of the subnet network ACL, including ephemeral ports.",
    ],
  },
  {
    id: "evidence-gap",
    metricId: "evidence-gap",
    warn: 1,
    crit: 50,
    title: "No flow evidence is available for the path",
    cause:
      "Flow logs are disabled, the log point is on the wrong resource, or the delivery path is broken. Without a record, a timeout cannot be localized from flow data alone.",
    fix:
      "Enable flow logs at the ENI, subnet, or VPC that covers the tested path, verify the delivery permissions, and reproduce the traffic. A missing record is evidence about the log point, not proof about the packet.",
    checkFirst: [
      "Confirm the flow log exists and is active for the source or destination ENI.",
      "Check the log destination, IAM role, and delivery errors.",
      "Reproduce the traffic and look for a NODATA or SKIPDATA record.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const flowLogsModel: SimModel = {
  id: "cloud-networking-flow-logs",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (values.rejectedRate >= 2 && frame.flags.rejectLogged !== 1) {
      pushEvent(next, {
        id: "flow-rejected",
        severity: "crit",
        title: "Flow log shows REJECT",
        detail: `${formatCount(values.rejected)} flows/min are rejected at the ${
          values.dropLayer === 1 ? "security group" : "network ACL"
        }. The record has the five-tuple and action, but not the payload.`,
        nodeId: values.dropLayer === 1 ? "sg" : "nacl",
        metricId: "rejected",
      });
    }
    next.flags.rejectLogged = values.rejectedRate >= 2 ? 1 : 0;
    if (!values.logs && frame.flags.blindLogged !== 1) {
      pushEvent(next, {
        id: "flow-blind",
        severity: "crit",
        title: "Flow logs are not recording the path",
        detail:
          "The traffic may be reaching the ENI or may be dropped earlier. Without a record, the flow log cannot distinguish those cases.",
        nodeId: "eni",
        metricId: "evidence-gap",
      });
    }
    next.flags.blindLogged = !values.logs ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (!values.logs) {
      items.push(
        "No flow records are available. That is an evidence gap, not proof that the packet never arrived. Check the log subscription and reproduce the traffic.",
      );
    } else if (values.rejectedRate > 0) {
      items.push(
        `${formatPercent(values.rejectedRate)}% of flows are rejected. The record names the five-tuple, action, and direction; use it to pick the security group or network ACL rule that denied the traffic.`,
      );
    } else {
      items.push(
        `All ${formatCount(values.observed)} flow records are accepted. The packet reached the ENI, so a timeout after this point is an application, listener, or response-path problem.`,
      );
    }
    items.push(
      values.dropLayer === 2
        ? "The subnet ACL is stateless. A rejected request can be paired with a rejected response, and the return direction has its own ephemeral-port rule."
        : values.dropLayer === 1
          ? "The security group is stateful. An inbound REJECT for the request is enough to identify the missing rule; the response is not evaluated separately."
          : "The path is allowed at both the ACL and the security group. The flow log confirms arrival, not application success.",
    );
    items.push(
      "Flow logs capture metadata at the ENI: addresses, ports, protocol, packets, bytes, action, and timestamps. They do not capture the payload, HTTP status, or the process that accepted the connection.",
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
    description: "Flow logs are on and every flow is accepted at the ENI.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Traffic reaches 4,800 flows/min; every flow is still accepted and recorded.",
    tone: "warn",
    params: defaults({ flows: 4_800 }),
  },
  {
    id: "failure",
    label: "Security group rejects",
    description: "Flow logs are on, but the destination security group has no inbound rule. The record shows REJECT.",
    tone: "crit",
    params: defaults({ logs: 1, dropLayer: 1, flows: 1_200 }),
  },
  {
    id: "blind",
    label: "Logging disabled",
    description: "Traffic is allowed, but no flow records exist. The path cannot be localized from flow data.",
    tone: "crit",
    params: defaults({ logs: 0, dropLayer: 0, flows: 1_200 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Logging is enabled and the security group allows the path again.",
    tone: "ok",
    params: defaults({ logs: 1, dropLayer: 0, flows: 1_200 }),
  },
];

const experiment: Experiment = {
  id: "predict-reject-record",
  title: "Predict the flow log action",
  simId: "flow-evidence",
  question:
    "A client connects to an instance on port 443. The destination security group has no inbound rule for the client. Flow logs are enabled on the instance ENI. What does the ENI record show for the request?",
  prediction: {
    options: [
      { id: "accept", label: "ACCEPT, because the packet reached the ENI." },
      { id: "reject", label: "REJECT, because the security group denied the flow." },
      { id: "nodata", label: "NODATA, because the application never responded." },
      { id: "no-record", label: "No record, because security groups are evaluated before flow logs." },
    ],
    correctOptionId: "reject",
    explanation:
      "The flow log records the traffic at the ENI with the action that the security group applied. An inbound request denied by the security group appears as REJECT. NODATA means no traffic was observed in the aggregation interval, not that the application failed. The record does not contain the HTTP status or the payload.",
  },
  setup: defaults({ logs: 1, dropLayer: 1, flows: 1_200 }),
  runFor: 12,
  observe: [
    "The flow record action is REJECT.",
    "The security group node is failing while the network ACL is healthy.",
    "The application never receives the flow.",
    "The record shows the five-tuple and bytes, not the HTTP request.",
  ],
  explain:
    "The flow log is an observation point at the ENI. It records whether the security group allowed or denied the traffic. A REJECT narrows the search to the rule layer; it does not name the exact rule, so the five-tuple and the rule set still have to be compared. A missing record would be a different problem: the log subscription or the log point, not the security group.",
  fix: defaults({ logs: 1, dropLayer: 0, flows: 1_200 }),
  debrief:
    "Read the action first, then the five-tuple, then the rule. A REJECT is evidence that the packet reached the ENI and a control denied it. An ACCEPT with a client timeout moves the investigation to the application or the return path.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Amazon VPC Flow Logs capture metadata about the IP traffic going to and from network interfaces in a VPC. A record includes the source and destination addresses and ports, protocol, packet and byte counts, start and end times, direction, and an action: ACCEPT or REJECT. Records can be delivered to CloudWatch Logs, Amazon S3, or Amazon Data Firehose.",
  },
  {
    type: "p",
    text: "Flow logs are collected outside the traffic path. They do not add latency, and they do not capture the payload. They answer whether a flow was observed at a log point and what action was applied. They do not answer whether the application returned a 500 or whether the database query succeeded.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The log point is the network interface, subnet, or VPC. For a connection to an instance, the destination ENI is the useful observation point. The record shows the flow after the security group decision. The network ACL is evaluated at the subnet boundary, and its rules are stateless, so the return direction is a separate decision.",
  },
  {
    type: "table",
    headers: ["Observation", "What it means", "What to check next", "What it does not prove"],
    rows: [
      ["ACCEPT", "The flow reached the ENI and a control allowed it", "Application listener, health, response path", "That the request succeeded."],
      ["REJECT", "A control denied the flow at the ENI", "Security group rule and both ACL directions", "Which exact rule, without the five-tuple."],
      ["NODATA", "No traffic was observed in the interval", "Log point, capture window, source path", "That the client never sent a packet."],
      ["No record", "The log subscription or delivery may be missing", "Flow log status and destination permissions", "That the packet never arrived."],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Rejected flows as a share of the tested traffic, with the drop point.",
      "Evidence gap when logging is disabled, separate from the traffic outcome.",
      "Accepted flows and observed records per minute.",
      "Five path nodes: client, network ACL, security group, ENI log point, and application.",
      "A prediction experiment that asks what a security group denial records.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Security group rejects and read the action before the rule. The application is failing, but the flow log is the evidence that localizes the drop. Next apply Logging disabled: the traffic is allowed, but the evidence gap is the failure. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "The flow counts, thresholds, and record rates are illustrative. The record fields, ACCEPT and REJECT semantics, and the observation-point limitation are the parts to carry into production.",
  },
  { type: "sim", simId: "flow-evidence" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With flow logs on and the security group denying the request, the ENI recorded REJECT. The application never saw the flow. The record did not name the exact rule, but it narrowed the search to the security group layer and the five-tuple in the record.",
  },
  {
    type: "p",
    text: "With logging off, the traffic was allowed but the evidence was gone. The client still timed out, and the flow log could not distinguish a packet that never left the client from one that reached the ENI and failed later. The missing subscription was the incident in the investigation, not the network path.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Flow log records: version, account, ENI, addresses, ports, protocol, packets, bytes, start, end, action, and log status.",
      "Security group rules: inbound rule for the source and port, and the stateful response behavior.",
      "Network ACL rules: inbound and outbound, including ephemeral ports for the return traffic.",
      "Flow log status: active subscription, delivery errors, and NODATA or SKIPDATA records.",
      "Application telemetry: listener state, request logs, status codes, and response time.",
      "Both directions: a request ACCEPT paired with a response REJECT points at the return path or a stateless ACL.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the action and the five-tuple before opening a rule editor. ACCEPT means the packet reached the ENI, so move to the application and the response path. REJECT means a control denied it, so check the security group and both directions of the ACL. No record means check the log point and delivery before drawing a conclusion about the packet.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the flow log is active for the ENI, subnet, or VPC that covers the path.",
      "Reproduce the traffic and read the action, five-tuple, and direction.",
      "For a REJECT, compare the record with the security group and both ACL directions.",
      "Add the narrowest rule that allows the intended source and port.",
      "For an ACCEPT with a client timeout, check the listener, application health, and response path.",
      "For NODATA or no record, check the capture window, log destination, and delivery role.",
      "Keep the log point and fields documented for the next investigation.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Flow logs add storage and ingestion cost. Choose the log point and fields that answer the operational question.",
      "A VPC-wide log is convenient but produces a large volume; an ENI-level log is narrower but can miss the source side.",
      "Short aggregation intervals improve detail but increase the number of records.",
      "Flow logs show metadata, not payload. For HTTP status or request bodies, use application logs or a proxy.",
      "A missing record is ambiguous. Keep a synthetic canary that proves the log pipeline is delivering.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "read-record",
    question: "A flow record shows REJECT for the client-to-server direction. What do you check?",
    difficulty: 2,
    hints: [
      "The record is at the ENI.",
      "Read the five-tuple before the rule set.",
    ],
    answer:
      "I would read the source and destination addresses and ports, protocol, direction, and the ENI or subnet in the record. A REJECT means a control denied the flow at that observation point. I would check the destination security group inbound rule first, then both directions of the subnet network ACL, including ephemeral ports. I would also check whether the record is from the source or destination ENI, because that changes which rules are in scope. Then I would add the narrowest rule and reproduce the traffic.",
    followUps: [
      "What would an ACCEPT in the same direction tell you?",
      "Why does the ENI matter?",
      "When would you look at the return direction?",
    ],
    redFlags: [
      "Opens every port.",
      "Ignores the direction.",
      "Assumes the application is down.",
    ],
    rubric: [
      "Reads the five-tuple and direction.",
      "Checks security group and ACL.",
      "Names the observation point.",
      "Adds a narrow rule and re-tests.",
    ],
  },
  {
    id: "accept-timeout",
    question:
      "The destination ENI shows ACCEPT, but the client still times out. What does that rule out, and what do you check next?",
    difficulty: 3,
    hints: [
      "ACCEPT is an observation at the ENI.",
      "The response is a separate flow.",
    ],
    answer:
      "It rules out a security group or ACL denial on the request path at that ENI. It does not prove the application received or processed the request, and it does not prove the response returned. I would check the listener, application logs, thread or connection pool saturation, and the response flow. On the return path I would check the source security group and the ACL in the opposite direction, because a stateless ACL can reject the response. A one-way ACCEPT is not a completed request.",
    followUps: [
      "What would a response REJECT tell you?",
      "How do you correlate the two directions?",
      "Which application metric would you check first?",
    ],
    redFlags: [
      "Declares the network healthy and stops.",
      "Ignores the return path.",
      "Restarts the application without evidence.",
    ],
    rubric: [
      "Limits what ACCEPT proves.",
      "Checks application health.",
      "Checks the response direction.",
      "Correlates request and response.",
    ],
  },
  {
    id: "missing-record",
    question:
      "There is no flow record for a connection that the client says it sent. What are the possible explanations?",
    difficulty: 3,
    hints: [
      "Absence is not proof.",
      "The log point and the capture window both matter.",
    ],
    answer:
      "The flow log may be disabled, attached to a different resource, or failing to deliver. The traffic may have been dropped before the log point, for example by a network ACL or a route that never reached the ENI. The connection may also fall outside the capture window, or the record may be NODATA or SKIPDATA. I would confirm the subscription and destination, reproduce the traffic, and check the source and destination log points. A missing record is evidence about the observation point, not proof that the packet never existed.",
    followUps: [
      "Which log point would you enable first?",
      "What does NODATA mean?",
      "How would you prove the pipeline works?",
    ],
    redFlags: [
      "Concludes the client is lying.",
      "Disables the investigation.",
      "Adds a broad allow rule.",
    ],
    rubric: [
      "Names subscription and delivery failures.",
      "Considers a drop before the log point.",
      "Mentions NODATA and capture window.",
      "Reproduces traffic and checks both ends.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Flow logs cover the ENIs, subnets, or VPCs that carry critical paths.",
      "The log destination, role, and delivery errors are monitored.",
      "A canary proves the flow-log pipeline is delivering.",
      "The record format includes the fields needed for the investigation.",
      "Security group and ACL owners are documented.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the log point and reproduce the traffic.",
      "Read action, five-tuple, direction, and bytes before the rules.",
      "For REJECT, check the security group and both ACL directions.",
      "For ACCEPT, check the listener, application, and response path.",
      "For no record, check the subscription, delivery, and capture window.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add the missing log point or field.",
      "Add a canary for the path and the log pipeline.",
      "Fix the rule in infrastructure code, not only in the console.",
      "Record which observation point answered the question.",
    ],
  },
];

const references = [
  {
    title: "Logging IP traffic using VPC Flow Logs",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Overview, log destinations, and the fact that flow logs are collected outside the traffic path.",
  },
  {
    title: "Flow log records",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/flow-log-records.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Default fields, action, direction, and log status.",
  },
  {
    title: "Flow log limitations",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs-limitations.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Traffic that is not captured and delivery limitations.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "flow-evidence": {
      model: flowLogsModel,
      presets,
      instructions:
        "Start healthy, then reject the flow at the security group and read the record action. Compare that with logging disabled, where the evidence is missing.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Flow rates and thresholds are teaching values; record semantics are real.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["cloud-networking-security-groups", "cloud-networking-nacls", "cloud-networking-reachability-analyzer"],
};
