import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "route",
    label: "Route present",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Path",
    help: "1 means the source subnet has a route to the destination CIDR. 0 means the analyzer stops at the route table.",
    format: "count" as const,
  },
  {
    id: "nacl",
    label: "NACL allows",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Path",
    help: "1 means the destination subnet network ACL allows the port in both directions. Network ACLs are stateless.",
    format: "count" as const,
  },
  {
    id: "sg",
    label: "Security group allows",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Path",
    help: "1 means the destination security group allows the source on the target port. Security groups are stateful.",
    format: "count" as const,
  },
  {
    id: "analyses",
    label: "Analysis load",
    min: 1,
    max: 60,
    step: 1,
    value: 5,
    unit: " paths/min",
    group: "Analyzer",
    help: "Paths analyzed per minute. High load adds API latency in this model; it does not change the configuration result.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  route: boolean;
  nacl: boolean;
  sg: boolean;
  analyses: number;
  reachable: boolean;
  blocker: "route" | "nacl" | "sg" | "none";
  blockedPaths: number;
  latency: number;
  reachableHops: number;
  routeHealth: Health;
  naclHealth: Health;
  sgHealth: Health;
  destHealth: Health;
}

function compute(p: Params): Computed {
  const route = num(p, "route", 1) >= 0.5;
  const nacl = num(p, "nacl", 1) >= 0.5;
  const sg = num(p, "sg", 1) >= 0.5;
  const analyses = Math.max(1, num(p, "analyses", 5));
  const blocker = !route ? "route" : !nacl ? "nacl" : !sg ? "sg" : "none";
  const reachable = blocker === "none";
  const latency = 600 + analyses * 200;
  return {
    route,
    nacl,
    sg,
    analyses,
    reachable,
    blocker,
    blockedPaths: reachable ? 0 : 100,
    latency,
    reachableHops: reachable ? 100 : blocker === "route" ? 20 : blocker === "nacl" ? 60 : 80,
    routeHealth: route ? "ok" : "crit",
    naclHealth: !route ? "ok" : nacl ? "ok" : "crit",
    sgHealth: !route || !nacl ? "ok" : sg ? "ok" : "crit",
    destHealth: reachable ? "ok" : "crit",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const rows: [string, number, number][] = [
    ["blocked-paths", values.blockedPaths, 0],
    ["analysis-latency", values.latency, 8],
    ["reachable-hops", values.reachableHops, 0],
    ["analyses", values.analyses, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) => {
      const wave = Math.sin((index + (seed % 3)) / 2.8) * amplitude;
      return Math.max(0, value + wave);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  return {
    t: 0,
    nodes: [
      {
        id: "source",
        label: "source ENI",
        kind: "service",
        health: "ok",
        sublabel: "10.0.1.10",
        detail: "The analyzer starts at this network interface. The source security group and route table are part of the evaluated path.",
        meta: { view: "flow" },
      },
      {
        id: "analyzer",
        label: "Reachability Analyzer",
        kind: "worker",
        health: values.latency >= 6_000 ? "crit" : values.latency >= 2_000 ? "warn" : "ok",
        sublabel: `${formatCount(values.analyses)} paths/min · ${Math.round(values.latency)} ms`,
        detail:
          values.latency >= 2_000
            ? "The analysis path is slow or throttled. The configuration verdict is still valid; the delay is in the analysis operation."
            : "The analyzer evaluates the configured path without sending traffic. A reachable result still needs a live request.",
        meta: { view: "flow" },
      },
      {
        id: "route",
        label: "rtb-private-a",
        kind: "mesh",
        health: values.routeHealth,
        sublabel: values.route ? "10.20.0.0/16 → tgw-attach" : "no matching route",
        detail: values.route
          ? "A route matches the destination and the target attachment is available. The analyzer continues to the destination subnet."
          : "No route matches the destination. The analyzer stops here and reports the route table as the blocking component.",
        meta: { view: "flow" },
      },
      {
        id: "nacl",
        label: "network ACL",
        kind: "mesh",
        health: values.naclHealth,
        sublabel: values.nacl ? "allow 443 in/out" : "deny 443 or ephemeral",
        detail: values.nacl
          ? "The destination subnet ACL allows the port and the return path. ACLs are stateless, so both directions matter."
          : "The destination subnet ACL blocks the port or the ephemeral return range. The analyzer reports the ACL as the blocker.",
        meta: { view: "flow" },
      },
      {
        id: "sg",
        label: "security group",
        kind: "mesh",
        health: values.sgHealth,
        sublabel: values.sg ? "allow from source SG" : "missing inbound rule",
        detail: values.sg
          ? "The destination security group allows the source reference on port 443. Stateful rules cover the response."
          : "The destination security group has no rule allowing the source on port 443. The analyzer reports the security group as the blocker.",
        meta: { view: "flow" },
      },
      {
        id: "dest",
        label: "dest ENI",
        kind: "service",
        health: values.destHealth,
        sublabel: values.reachable ? "configuration reachable" : `blocked at ${values.blocker}`,
        detail: values.reachable
          ? "The configuration path is reachable. The analyzer does not prove that the application is listening, healthy, or able to serve the request."
          : "The destination is never reached in the configuration. Fix the reported blocker before testing the application.",
        meta: { view: "flow", blocker: values.blocker },
      },
    ],
    edges: [
      edge("source-analysis", "source", "analyzer", 1, values.latency >= 6_000 ? "crit" : "ok"),
      edge("source-route", "source", "route", values.route ? 1 : 0, values.routeHealth),
      edge("route-nacl", "route", "nacl", values.route ? 1 : 0, values.naclHealth),
      edge("nacl-sg", "nacl", "sg", values.route && values.nacl ? 1 : 0, values.sgHealth),
      edge("sg-dest", "sg", "dest", values.reachable ? 1 : 0, values.destHealth),
    ],
    metrics: [
      metric("blocked-paths", "Blocked paths", values.blockedPaths, "%", 1, 50, "percent"),
      metric("analysis-latency", "Analysis latency", values.latency, " ms", 2_000, 6_000, "ms"),
      metric("reachable-hops", "Reachable hops", values.reachableHops, "%", undefined, undefined, "percent"),
      metric("analyses", "Analyses", values.analyses, " paths/min", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: values.reachable
      ? `Path reachable by configuration; ${formatCount(values.analyses)} analyses/min; ${Math.round(
          values.latency,
        )} ms analysis.`
      : `Path blocked at ${values.blocker}; ${formatCount(values.analyses)} analyses/min; ${Math.round(
          values.latency,
        )} ms analysis.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "blocked-paths",
    metricId: "blocked-paths",
    warn: 1,
    crit: 50,
    title: "The analyzed path is blocked by configuration",
    cause:
      "A route, network ACL, or security group does not allow the source to reach the destination on the tested port. The analyzer returns the first blocking component in evaluation order.",
    fix:
      "Fix the reported component, then re-run the analysis. Do not change downstream components until the earlier blocker is cleared, because the path is not evaluated past it.",
    checkFirst: [
      "Read the blocking component in the analyzer result.",
      "Check the route table for the destination CIDR before the ACL and security group.",
      "Check both directions of the network ACL and the source reference in the security group.",
    ],
  },
  {
    id: "analysis-latency",
    metricId: "analysis-latency",
    warn: 2_000,
    crit: 6_000,
    title: "Path analysis is slow or throttled",
    cause:
      "Too many analyses are running at once, or the analyzer API is throttled. This delays the answer but does not change the configuration result.",
    fix:
      "Batch analyses, cache results for unchanged paths, and retry with backoff. Keep a live packet test for the paths that matter during an incident.",
    checkFirst: [
      "Check the analysis API error rate and throttle response.",
      "Confirm whether the path configuration changed since the last cached result.",
      "Use a saved analysis for a known path instead of re-running it repeatedly.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const reachabilityAnalyzerModel: SimModel = {
  id: "cloud-networking-reachability-analyzer",
  visual: "topology",
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
    const jitter = rng.between(-5, 5);
    next.metrics = next.metrics.map((item) =>
      item.id === "analysis-latency" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (!values.reachable && frame.flags.blockedLogged !== 1) {
      pushEvent(next, {
        id: "path-blocked",
        severity: "crit",
        title: `Path blocked at ${values.blocker}`,
        detail:
          values.blocker === "route"
            ? "No route matches the destination. The analyzer stops at the route table."
            : values.blocker === "nacl"
              ? "The route matches, but the destination network ACL blocks the port or the return path."
              : "The route and ACL allow the traffic, but the destination security group has no matching inbound rule.",
        nodeId: values.blocker,
        metricId: "blocked-paths",
      });
    }
    next.flags.blockedLogged = values.reachable ? 0 : 1;
    if (values.latency >= 6_000 && frame.flags.slowLogged !== 1) {
      pushEvent(next, {
        id: "analysis-slow",
        severity: "crit",
        title: "Path analysis is above its latency budget",
        detail: `${formatCount(values.analyses)} analyses/min produce ${Math.round(
          values.latency,
        )} ms per result. The configuration answer is unchanged; the delay is in the analysis path.`,
        nodeId: "source",
        metricId: "analysis-latency",
      });
    }
    next.flags.slowLogged = values.latency >= 6_000 ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.reachable) {
      items.push(
        "The configuration path is reachable: route, network ACL, and security group all allow the tested traffic. That is a statement about configuration, not about the application.",
      );
    } else {
      items.push(
        `The path stops at ${values.blocker}. The analyzer reports the first blocker in evaluation order, so downstream rules are not evidence that the path works.`,
      );
    }
    items.push(
      values.blocker === "route"
        ? "No route matched the destination. A security group change cannot fix a missing route; the packet never reaches the destination subnet."
        : values.blocker === "nacl"
          ? "The route matched and the ACL blocked the traffic. Network ACLs are stateless, so the return direction and ephemeral ports matter."
          : values.blocker === "sg"
            ? "The route and ACL allowed the traffic, but the destination security group did not. A source security group reference is safer than a CIDR range."
            : "The configuration is complete. The next check is a real packet: listener, certificate, application health, and capacity.",
    );
    items.push(
      `Analysis latency is ${Math.round(values.latency)} ms at ${formatCount(
        values.analyses,
      )} paths/min. Slow analysis does not change the path verdict; it changes how quickly you can make a change safely.`,
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Route, network ACL, and security group all allow the path. Analysis is fast.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Twenty analyses per minute; the path is reachable and analysis latency is elevated.",
    tone: "warn",
    params: defaults({ analyses: 20 }),
  },
  {
    id: "failure",
    label: "Security group blocks",
    description: "The route and ACL allow the traffic, but the destination security group has no matching inbound rule.",
    tone: "crit",
    params: defaults({ sg: 0, analyses: 5 }),
  },
  {
    id: "throttled",
    label: "Analyzer throttled",
    description: "Fifty analyses per minute push the analysis API over its latency budget.",
    tone: "crit",
    params: defaults({ analyses: 50 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The missing security group rule is restored and the analysis returns reachable.",
    tone: "ok",
    params: defaults({ sg: 1, analyses: 5 }),
  },
];

const experiment: Experiment = {
  id: "predict-analyzer-limit",
  title: "Predict what the analyzer proves",
  simId: "path-analysis",
  question:
    "Reachability Analyzer reports the path from the load balancer to the target as reachable. The application still times out. What is the most likely explanation?",
  prediction: {
    options: [
      { id: "config-wrong", label: "The analyzer result is wrong; a reachable path always carries traffic." },
      { id: "app", label: "The configuration is reachable, but the application is not listening or is out of capacity." },
      { id: "sg", label: "A security group must still be blocking the return path." },
      { id: "route", label: "The route table must have a blackhole route the analyzer ignored." },
    ],
    correctOptionId: "app",
    explanation:
      "Reachability Analyzer evaluates the configured path. It can prove that a route, ACL, and security group combination allows the packet. It cannot prove that the process is listening, the certificate is valid, the target is healthy, or the target has capacity. Those need a real request and application telemetry.",
  },
  setup: defaults(),
  runFor: 12,
  observe: [
    "The analyzer reports a reachable configuration.",
    "No blocking component is present in the path.",
    "The analysis latency is independent of application health.",
    "A live request is still required to prove the service works.",
  ],
  explain:
    "Configuration analysis and live traffic answer different questions. The analyzer removes the network-configuration hypothesis quickly and safely. It does not replace a packet test at the destination. Treat a reachable result as permission to test the application, not as proof that the request succeeds.",
  fix: defaults(),
  debrief:
    "Use the analyzer before the change to find configuration blockers without sending traffic. After the change, send a real request and check the listener, certificate, application health, and capacity. The analyzer narrows the search; it does not close the incident.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "AWS Reachability Analyzer is a configuration analysis tool for Amazon Virtual Private Cloud (VPC) paths. Given a source and destination, it evaluates the route tables, network ACLs, security groups, load balancers, and other components along the path. It returns a hop-by-hop view or the component that blocks the path. It does not send production traffic.",
  },
  {
    type: "p",
    text: "That makes it a safe pre-change check. You can ask whether a new route, subnet, or security group would allow the intended path before changing production. The result is only as good as the configuration and the source and destination you specify. It is not a live health check.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The evaluated path is source network interface, route table, network ACL, security group, destination network interface. The analyzer follows the configuration in evaluation order and stops at the first blocker. A route miss is reported before an ACL or security group, because the packet would never reach those components.",
  },
  {
    type: "table",
    headers: ["Result", "What it proves", "What it does not prove", "Next step"],
    rows: [
      ["Reachable", "The configured components allow the path", "The application is listening or healthy", "Send a real request and check the target."],
      ["Blocked at route", "No route matches the destination", "Whether a downstream rule would allow it", "Fix the route, then re-analyze."],
      ["Blocked at ACL", "The route matched but the subnet ACL blocked", "Whether the security group would allow it", "Fix both directions and ephemeral ports."],
      ["Blocked at security group", "The route and ACL allowed but the group did not", "Whether the application would accept the request", "Add the narrow source rule, then test live."],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Blocked paths as a percentage of the analyzed path, with the first blocking component.",
      "Analysis latency and analysis load, which are separate from the path verdict.",
      "Five path nodes: source ENI, route table, network ACL, security group, destination ENI.",
      "A reachable-hops metric that shows where evaluation stopped.",
      "A prediction experiment that separates configuration reachability from application health.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply Security group blocks and read the path in order: the route and ACL stay healthy, and the security group is the first failure. Then apply Analyzer throttled and note that the verdict is unchanged while the analysis latency crosses critical. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "The analysis latency, path rate, and thresholds are illustrative. The evaluation order, the meaning of the blocking component, and the distinction from live traffic are the parts to carry into production.",
  },
  { type: "sim", simId: "path-analysis" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The security group preset produced a blocked path with the route and ACL still healthy. The analyzer stopped at the destination security group, which is the first component that denied the traffic. Changing the route table would not have helped.",
  },
  {
    type: "p",
    text: "The throttled preset told a different story. The path was reachable and the configuration answer was correct, but the analysis itself was slow. That is an operational limit of the tool, not a property of the network path.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Analyzer result: reachable or blocked, the hop-by-hop path, and the blocking component.",
      "Route tables: the matching destination, target, and state for the source subnet.",
      "Network ACLs: inbound and outbound rules, including ephemeral ports and the return direction.",
      "Security groups: the source reference, port, and protocol on the destination ENI.",
      "Application evidence: listener state, certificate, health check, and target response time.",
      "API throttling: analysis errors or latency when many paths are evaluated at once.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the blocking component before changing anything. Fix the first blocker and re-run the analysis; a downstream rule is not evidence until the earlier hop allows the packet. When the analyzer says reachable, move to a real request and application telemetry.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Define the exact source, destination, port, and protocol you are testing.",
      "Run the analyzer and record the blocking component or the hop-by-hop path.",
      "Fix the first blocker only, then re-run the analysis.",
      "Check both directions of the network ACL and the return traffic path.",
      "Use security group references rather than broad CIDR ranges.",
      "Send a real request after the configuration is reachable; check listener, certificate, health, and capacity.",
      "Save the analysis for the critical path and re-run it when the topology changes.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Configuration analysis is safe and fast, but it cannot prove live forwarding or application health.",
      "A reachable result can create false confidence if the team skips the packet test.",
      "The analyzer evaluates the source and destination you specify. A path that works for one ENI may not work for another.",
      "Analysis API limits matter during a broad outage, when many teams run the same check at once.",
      "Fixing only the reported blocker is correct for the tested port, but a different port or protocol may have another blocker.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "analyzer-meaning",
    question: "What does a Reachability Analyzer result prove, and what does it not prove?",
    difficulty: 2,
    hints: [
      "It reads configuration.",
      "It does not send production traffic.",
    ],
    answer:
      "It proves that the configured components along the specified path allow the traffic: route tables, network ACLs, security groups, and the other evaluated resources. It does not prove that the application is listening, that the certificate is valid, that the target is healthy, or that the target has capacity. A reachable result means the network configuration is not the blocker; the next step is a real request and application telemetry.",
    followUps: [
      "When would you use it before a change?",
      "What would you do if it says reachable but traffic fails?",
      "Which components does it evaluate?",
    ],
    redFlags: [
      "Treats it as a live monitor.",
      "Skips the application check.",
      "Assumes one path proves every source.",
    ],
    rubric: [
      "Describes configuration analysis.",
      "Names what it cannot prove.",
      "Pairs it with a live test.",
      "Mentions the specified source and destination.",
    ],
  },
  {
    id: "blocking-order",
    question:
      "The analyzer reports a security group blocking the path. Why should you not start by editing the security group?",
    difficulty: 3,
    hints: [
      "It reports the first blocker.",
      "Downstream rules are not evaluated yet.",
    ],
    answer:
      "The analyzer reports the first component that blocks the tested path. If it reached the security group, the route and ACL already allowed the traffic, so the security group is the right place to look for this path. But I would still read the full result and confirm the source, destination, port, and protocol. I would fix that rule, re-run the analysis, and then check the return path and the application. If the result were blocked at the route, editing the security group would be wasted work because the packet never reaches it.",
    followUps: [
      "How does the evaluation order change your fix?",
      "What would you check after the security group allows the traffic?",
      "Why can a different port still fail?",
    ],
    redFlags: [
      "Edits every component at once.",
      "Ignores the tested port.",
      "Assumes a reachable configuration is a working service.",
    ],
    rubric: [
      "Explains first-blocker order.",
      "Confirms source, destination, and port.",
      "Fixes one component then re-runs.",
      "Moves to live testing.",
    ],
  },
  {
    id: "before-change",
    question: "How would you use the analyzer to de-risk a route change before production?",
    difficulty: 2,
    hints: [
      "Build the change in a non-production path first.",
      "Compare the result with a live packet test.",
    ],
    answer:
      "I would model the proposed source, destination, port, and protocol in a non-production environment or a temporary path, then run the analyzer and record the result. I would check the route table, ACL, and security group in evaluation order and fix any blocker before the change window. After the production change, I would send a real request and watch the application and flow logs. The analyzer reduces the configuration risk; the live test proves the data plane.",
    followUps: [
      "What would you save for the next change?",
      "How do you test the return path?",
      "What if the analyzer API is unavailable during the window?",
    ],
    redFlags: [
      "Skips the non-production test.",
      "Changes production and hopes.",
      "Does not verify the return path.",
    ],
    rubric: [
      "Models the exact path.",
      "Uses evaluation order.",
      "Runs a live test after the change.",
      "Saves the analysis for reuse.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Critical source, destination, port, and protocol pairs have saved analyses.",
      "Route tables, ACLs, and security groups have named owners.",
      "The analyzer is part of the change review for new paths.",
      "A live packet test exists for each critical path.",
      "Analysis API limits and retry behavior are known.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Run the analyzer with the exact source, destination, and port.",
      "Read the blocking component before changing any rule.",
      "Fix the first blocker and re-run the analysis.",
      "Check both directions of the network ACL.",
      "Send a real request after the configuration is reachable.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Save the analysis for the restored path.",
      "Add the missing rule to infrastructure code.",
      "Check for other paths with the same pattern.",
      "Record whether the failure was configuration or application health.",
    ],
  },
];

const references = [
  {
    title: "What is Reachability Analyzer?",
    url: "https://docs.aws.amazon.com/vpc/latest/reachability/what-is-reachability-analyzer.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Explains configuration path analysis and the blocking component result.",
  },
  {
    title: "Create and analyze a path",
    url: "https://docs.aws.amazon.com/vpc/latest/reachability/getting-started.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Shows how to specify source, destination, protocol, and port.",
  },
  {
    title: "How Reachability Analyzer works",
    url: "https://docs.aws.amazon.com/vpc/latest/reachability/how-reachability-analyzer-works.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Explains the path analysis, reachable result, and blocking component.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "path-analysis": {
      model: reachabilityAnalyzerModel,
      presets,
      instructions:
        "Start healthy, then block the security group and read the path in order. Compare a blocked path with a slow analysis; only one changes the verdict.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Analysis latency and path rate are teaching values, not service quotas.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["cloud-networking-route-tables", "cloud-networking-security-groups", "cloud-networking-flow-logs"],
};
