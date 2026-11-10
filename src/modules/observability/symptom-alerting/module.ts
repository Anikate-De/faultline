import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ALLOWED_PCT = 0.1;
const LATENCY_TARGET_MS = 500;
const CAUSE_PAGES_PER_WEEK = 7;
const ERROR_SYMPTOM_PAGES = 7;
const LATENCY_SYMPTOM_PAGES = 5;

const params: ParamSpec[] = [
  {
    id: "cpuUtilizationPct",
    label: "Peak CPU utilization",
    min: 20,
    max: 100,
    step: 1,
    value: 62,
    unit: "%",
    group: "Nightly batch",
    help: "The CPU level during the nightly batch window. High CPU is a cause signal, not proof of user impact.",
    format: "percent",
  },
  {
    id: "cpuAlertThresholdPct",
    label: "CPU alert threshold",
    min: 50,
    max: 99,
    step: 1,
    value: 80,
    unit: "%",
    group: "Nightly batch",
    help: "The line that fires the CPU alert. Crossing it says a resource is busy, not that requests are failing.",
    format: "percent",
  },
  {
    id: "errorRatePct",
    label: "Bad event rate",
    min: 0,
    max: 5,
    step: 0.01,
    value: 0.04,
    unit: "%",
    group: "User impact",
    help: "The SLI failure rate. A 99.9% SLO allows 0.1%, so anything above that is user impact.",
    format: "percent",
  },
  {
    id: "p99Ms",
    label: "p99 latency",
    min: 50,
    max: 2_000,
    step: 10,
    value: 240,
    unit: "ms",
    group: "User impact",
    help: "The latency symptom. Above 500ms the request is slow enough to count as user pain.",
    format: "ms",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  cpu: number;
  threshold: number;
  errorPct: number;
  p99: number;
  causePages: number;
  errorPages: number;
  latencyPages: number;
  symptomPages: number;
  totalPages: number;
  noiseRatio: number;
  actionability: number;
  userImpact: boolean;
  causeNoImpact: boolean;
}

function compute(p: Params): Computed {
  const cpu = num(p, "cpuUtilizationPct", 62);
  const threshold = num(p, "cpuAlertThresholdPct", 80);
  const errorPct = num(p, "errorRatePct", 0.04);
  const p99 = num(p, "p99Ms", 240);
  const causePages = cpu >= threshold ? CAUSE_PAGES_PER_WEEK : 0;
  const errorPages = errorPct > ALLOWED_PCT ? ERROR_SYMPTOM_PAGES : 0;
  const latencyPages = p99 > LATENCY_TARGET_MS ? LATENCY_SYMPTOM_PAGES : 0;
  const symptomPages = errorPages + latencyPages;
  const totalPages = causePages + symptomPages;
  const userImpact = errorPct > ALLOWED_PCT || p99 > LATENCY_TARGET_MS;
  return {
    cpu,
    threshold,
    errorPct,
    p99,
    causePages,
    errorPages,
    latencyPages,
    symptomPages,
    totalPages,
    noiseRatio: totalPages > 0 ? (causePages / totalPages) * 100 : 0,
    actionability: totalPages > 0 ? (symptomPages / totalPages) * 100 : 100,
    userImpact,
    causeNoImpact: causePages > 0 && !userImpact,
  };
}

function impactHealth(values: Computed): "ok" | "warn" | "crit" {
  if (!values.userImpact) return "ok";
  if (values.errorPct > 1 || values.p99 > 1_000) return "crit";
  return "warn";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const impact = impactHealth(values);
  const cpuRule: "ok" | "warn" = values.causePages > 0 ? "warn" : "ok";
  const sloRule = impact;
  const pagerHealth: "ok" | "warn" | "crit" =
    values.noiseRatio >= 80 ? "crit" : values.noiseRatio >= 50 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "users",
        label: "Users",
        kind: "client",
        health: "ok",
        throughput: 12_000,
        sublabel: "12k requests/min",
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Checkout service",
        kind: "service",
        health: impact,
        utilization: clamp(values.p99 / 2_000),
        sublabel: `${values.errorPct.toFixed(2)}% bad, p99 ${Math.round(values.p99)}ms`,
        detail: "The service is healthy when requests succeed within the latency target. CPU is a resource view, not a user view.",
        meta: { view: "flow" },
      },
      {
        id: "cpu-rule",
        label: "CPU cause alert",
        kind: "service",
        health: cpuRule,
        utilization: clamp(values.cpu / 100),
        sublabel: `${Math.round(values.cpu)}% vs ${Math.round(values.threshold)}%`,
        detail: "A cause alert. It says a resource crossed a line; it does not say a user noticed.",
        meta: { view: "flow" },
      },
      {
        id: "slo-rule",
        label: "SLO symptom alert",
        kind: "service",
        health: sloRule,
        utilization: clamp(values.errorPct / 5),
        sublabel: values.userImpact ? "user impact detected" : "within SLO",
        detail: "A symptom alert. It fires when the error rate or latency shows user-visible pain.",
        meta: { view: "flow" },
      },
      {
        id: "pager",
        label: "On-call pager",
        kind: "worker",
        health: pagerHealth,
        sublabel: `${values.causePages} cause / ${values.symptomPages} symptom pages per week`,
        detail: "Every cause page that does not correspond to user impact trains the responder to discount the next page.",
        meta: { view: "flow" },
      },
      {
        id: "tickets",
        label: "Ticket queue",
        kind: "storage",
        health: "ok",
        sublabel: "cause signals for daytime review",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("users-service", "users", "service", 0.9, impact),
      edge("service-cpu", "service", "cpu-rule", 0.5, cpuRule),
      edge("service-slo", "service", "slo-rule", 0.8, sloRule),
      edge("cpu-pager", "cpu-rule", "pager", 0.4, cpuRule),
      edge("slo-pager", "slo-rule", "pager", 0.8, sloRule),
      edge("cpu-tickets", "cpu-rule", "tickets", 0.4, "ok"),
    ],
    metrics: [
      metric("page-volume", "Pages per week", values.totalPages, "", 8, 18, "count"),
      metric("noise-ratio", "Cause pages share", values.noiseRatio, "%", 50, 80, "percent"),
      metric("cause-no-impact", "Cause page without impact", values.causeNoImpact ? 1 : 0, "", 0.5, 0.5, "number"),
      metric("cause-pages", "Cause pages", values.causePages, "", undefined, undefined, "count"),
      metric("symptom-pages", "Symptom pages", values.symptomPages, "", undefined, undefined, "count"),
      metric("actionability", "Actionable page share", values.actionability, "%", undefined, undefined, "percent"),
      metric("user-impact", "User impact", values.userImpact ? 1 : 0, "", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.totalPages} pages per week, ${values.noiseRatio.toFixed(0)}% of them cause-only; user impact is ${values.userImpact ? "present" : "absent"}.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const offset = seed % 7;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, item.value * (0.9 + 0.2 * Math.sin((index + offset) / 2.1))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "noise-ratio",
    metricId: "noise-ratio",
    warn: 50,
    crit: 80,
    title: "Cause pages are consuming pager capacity",
    cause:
      "Cause alerts take up half or more of the pager, and they do not prove user impact on their own. The pager spends capacity on resource signals while the symptom is what needs a response.",
    fix:
      "Move cause alerts to tickets or a dashboard. Page on the SLO symptom, and keep the cause signals as context that the responder can open after the page.",
    checkFirst: [
      "Compare every paging rule with the SLI it is supposed to protect.",
      "Check whether the cause alert has a documented user-visible consequence.",
      "Look at the last ten pages and count how many led to an action.",
    ],
  },
  {
    id: "cause-no-impact",
    metricId: "cause-no-impact",
    warn: 0.5,
    crit: 0.5,
    title: "A cause alert paged with no user impact",
    cause:
      "A resource threshold was crossed while error rate and latency stayed inside the SLO. Waking someone for this teaches the team that pages are optional.",
    fix:
      "Route the rule to a ticket queue and keep the dashboard link. If the resource trend can become user impact, alert on the symptom it would eventually produce.",
    checkFirst: [
      "Confirm the SLI is healthy at the same timestamp as the page.",
      "Check whether the resource is approaching a real limit or is simply busy.",
      "Decide whether the rule should page, ticket, or be removed.",
    ],
  },
  {
    id: "page-volume",
    metricId: "page-volume",
    warn: 8,
    crit: 18,
    title: "Page volume is above what one responder can triage",
    cause:
      "The pager is carrying more alerts than a shift can investigate. Volume alone is not the goal, but beyond a threshold the responder starts skimming instead of reading.",
    fix:
      "Rank alerts by actionability and SLO impact, remove duplicates, and route diagnostic signals away from the pager. Measure the pages that led to action, not only the total.",
    checkFirst: [
      "Split pages by rule and by team ownership.",
      "Check which pages repeat without a state change.",
      "Compare page volume with the number of real incidents that week.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const symptomModel: SimModel = {
  id: "observability-symptom-alerting",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p) => {
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The CPU alert fires at ${values.threshold}% and the service is at ${values.cpu}%. That is a cause signal, not a user signal.`,
      `User impact is ${values.userImpact ? "present" : "absent"}: ${values.errorPct.toFixed(2)}% bad events against a ${ALLOWED_PCT}% allowance, and p99 ${Math.round(values.p99)}ms against a ${LATENCY_TARGET_MS}ms target.`,
      `The current mix is ${values.causePages} cause pages and ${values.symptomPages} symptom pages per week, so ${values.noiseRatio.toFixed(0)}% of pages do not prove impact.`,
      values.userImpact
        ? "The SLO symptom is the page. Keep the CPU signal as context so the responder can see whether saturation explains the pain."
        : "The CPU signal belongs in a ticket. The pager should stay quiet until the SLO symptom moves.",
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Cause page", tone: "warn" },
    { label: "Symptom page", tone: "crit" },
    { label: "Diagnostic", tone: "info" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "CPU stays below its alert line and both SLO symptoms are inside target.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Evening peak",
    description: "CPU is above its line and latency is slightly high. The cause page and the symptom page both fire.",
    tone: "warn",
    params: defaults({ cpuUtilizationPct: 88, errorRatePct: 0.15, p99Ms: 450 }),
  },
  {
    id: "failure",
    label: "Nightly CPU page",
    description: "CPU is at 94% with errors and latency inside target. The cause alert pages; users are fine.",
    tone: "crit",
    params: defaults({ cpuUtilizationPct: 94, errorRatePct: 0.03, p99Ms: 260 }),
  },
  {
    id: "symptom-only",
    label: "Symptom only",
    description: "CPU is quiet while errors and latency breach the SLO. The symptom page is the only useful alert.",
    tone: "warn",
    params: defaults({ cpuUtilizationPct: 55, errorRatePct: 1.2, p99Ms: 1_300 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "CPU is below its line and the SLO is back inside target. No page is justified.",
    tone: "ok",
    params: defaults({ cpuUtilizationPct: 74, errorRatePct: 0.02, p99Ms: 210 }),
  },
];

const experiment: Experiment = {
  id: "predict-cause-page",
  title: "Predict the pager outcome",
  simId: "symptoms",
  question:
    "CPU is at 94% and the CPU alert is set at 80%. Error rate is 0.03% against a 99.9% SLO, and p99 is 260ms. What should happen?",
  prediction: {
    options: [
      { id: "cause-page", label: "The CPU rule pages, but there is no user impact to justify it" },
      { id: "symptom-page", label: "The SLO symptom pages because CPU is high" },
      { id: "both", label: "Both the CPU and SLO rules page" },
      { id: "none", label: "Nothing should happen because CPU is below 100%" },
    ],
    correctOptionId: "cause-page",
    explanation:
      "The CPU rule is above its threshold, so it pages. The SLI is healthy: 0.03% is below the 0.1% allowance and 260ms is below the 500ms target. The CPU page is a cause alert with no demonstrated user impact, so it should be a ticket or a dashboard signal, not a wake-up.",
  },
  setup: defaults({ cpuUtilizationPct: 94, errorRatePct: 0.03, p99Ms: 260 }),
  runFor: 20,
  observe: [
    "The CPU node is above its alert line and the pager shows a cause page.",
    "The SLO node stays healthy; no symptom alert fires.",
    "The cause share of pages is 100%, so the pager is carrying no user evidence.",
    "The user-impact metric is zero even though a resource threshold is crossed.",
  ],
  explain:
    "Symptom alerts answer whether users are affected. Cause alerts answer why the system might be affected. A cause can be present without impact, and impact can arrive without the expected cause. Paging on the cause makes the responder investigate a healthy request path at 2 a.m.; paging on the symptom makes the page mean that someone is hurting.",
  fix: defaults({ cpuUtilizationPct: 94, cpuAlertThresholdPct: 96, errorRatePct: 0.03, p99Ms: 260 }),
  debrief:
    "Raising the CPU line removes the page but leaves the CPU signal available for diagnosis. The tradeoff is that a real CPU problem which has not yet reached users will not wake anyone; that is the correct default when the SLO is healthy, provided the trend is reviewed and capacity work is planned. The symptom alert remains the pager, and the cause signal explains the symptom when it eventually appears.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A symptom alert measures what a user experiences: failed requests, slow requests, or a drop in a business action. A cause alert measures a condition that might produce that experience: CPU, memory, queue depth, a dependency error, or a certificate expiry. Both are useful. They answer different questions and belong in different places.",
  },
  {
    type: "p",
    text: "The distinction matters because a cause can be present without impact. A nightly batch can push CPU to 90% while every request still succeeds inside its latency target. Paging on the CPU line wakes someone for a healthy product. The inverse also happens: a service can fail with every resource looking normal because the failure is in a dependency or a configuration path. A pager built only on causes can be loud and blind at the same time.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The measurement path is user traffic, then the SLI that classifies good and bad events, then the symptom rule that pages on SLO impact. Cause signals branch off the same service and feed dashboards, tickets, and the diagnostic section of the runbook. They should be one click from the page, not the reason for it.",
  },
  {
    type: "table",
    headers: ["Alert", "Signal", "Proves user impact?", "Default route"],
    rows: [
      ["Error budget burn", "Bad events divided by allowed events", "Yes, if the SLI is valid", "Page"],
      ["Latency above target", "p99 against the latency SLO", "Yes", "Page"],
      ["CPU above threshold", "Resource utilization", "No", "Ticket or dashboard"],
      ["Disk filling", "Capacity trend", "Not yet", "Ticket with a deadline"],
      ["Dependency error spike", "Upstream failures", "Only if requests fail", "Page if the SLI moves"],
    ],
  },
  {
    type: "p",
    text: "The model is illustrative. It uses a 99.9% error SLO and a 500ms latency target so the two symptom conditions are easy to compare. Page counts are per week and are teaching values, not a claim about a specific pager vendor or team.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A CPU cause rule that fires against its own threshold, independent of user impact.",
      "An SLO symptom rule that responds to the error rate and the latency target.",
      "Page volume per week and the share of pages that are cause-only.",
      "A pager node whose health reflects noise, not the number of alerts alone.",
      "A ticket path that keeps the cause signal without waking anyone.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Nightly CPU page. Watch the CPU rule turn critical while the SLO node stays healthy. Compare that with Symptom only, where the CPU line is quiet but users are failing. Then run the experiment and raise the CPU threshold to see the page disappear without losing the diagnostic signal.",
  },
  {
    type: "compare",
    leftTitle: "Cause alert",
    rightTitle: "Symptom alert",
    rows: [
      { label: "Question", left: "Why might users be affected?", right: "Are users affected now?" },
      { label: "Evidence", left: "A resource or dependency crossed a line", right: "The SLI moved outside its target" },
      { label: "Failure mode", left: "Pages on busy but healthy systems", right: "Can miss a cause that has not reached the SLI" },
      { label: "Use", left: "Diagnosis, capacity planning, tickets", right: "Paging and incident declaration" },
    ],
  },
  { type: "sim", simId: "symptoms" },
  { type: "experiment", experimentId: "predict-cause-page" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The CPU rule crossed its line and paged, but the SLI stayed inside its target. The pager carried a cause with no symptom. In the symptom-only preset, the opposite happened: the resource was quiet while errors and latency proved that users were hurting. The page volume and the user-impact metric disagreed, which is the whole problem.",
  },
  {
    type: "p",
    text: "The cause share made the noise visible. When every page is a cause page, the responder learns that a page does not mean an incident. The fix is not to delete the cause signal; it is to move it to a ticket or a dashboard and keep the symptom alert as the wake-up.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Prometheus and Alertmanager: separate route labels for `page` and `ticket`, with the page route reserved for SLO burn and the ticket route for resource trends.",
      "PagerDuty or another pager: incident volume by service, acknowledgement time, and the share of pages that were resolved without a user-visible action.",
      "Grafana: a top row with the SLI, burn, and current error budget, then cause panels below it for diagnosis.",
      "CloudWatch or Datadog: CPU and memory alarms routed to a ticket topic, with the SLO monitor routed to the pager.",
      "Logs and traces: the failing route and dependency that explain a symptom page. A cause page without a trace is usually a resource signal.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "For each paging rule, ask what user-visible signal it protects and what action the responder should take. If the answer is only that a resource is high, it is a ticket. Confirm the SLI is healthy at the same timestamp before you decide the page was noise.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "List every paging rule and label it symptom or cause using the signal it measures.",
      "For each cause rule, name the symptom it would eventually produce and the threshold at which that symptom pages.",
      "Move cause-only rules to a ticket queue with an owner and a review deadline.",
      "Keep cause panels on the incident dashboard and link them from the symptom runbook.",
      "Tune the symptom alert to the SLO, not to the resource. Test it with a real user-facing failure.",
      "Review the last twenty pages and count how many produced an action. Repeat after the change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Symptom-only paging can miss a cause that is about to become impact, so cause signals still need owners and tickets.",
      "Cause alerts are cheap to write and expensive to carry; every one adds a page that may not matter.",
      "A latency SLO can page before errors rise, which is useful for a slow product and noisy for a batch job.",
      "Routing causes to tickets can hide a trend if nobody reads the queue; the queue needs a service-level expectation too.",
      "A symptom alert depends on a correct SLI. A bad classification makes the pager quiet for the wrong reason.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "classify-alerts",
    question:
      "Classify these as symptom or cause alerts: CPU above 90%, error budget burn above 14.4x, p99 above 500ms, disk 85% full, and a dependency returning 503s.",
    difficulty: 2,
    hints: [
      "Ask whether the signal proves a user-visible outcome.",
      "A dependency error is only a symptom if requests actually fail.",
    ],
    answer:
      "Error budget burn and p99 above the latency target are symptoms because they measure user-visible failure or delay. CPU above 90%, disk 85% full, and a dependency returning 503s are causes until the SLI shows impact. The dependency case can become a symptom if the service has no fallback and requests fail, but the raw upstream error is still a cause signal. I would page on the symptoms, keep the causes as context, and give each cause an owner and a ticket path.",
    followUps: [
      "What if the dependency error is masked by a retry?",
      "Which cause would you keep as a page?",
      "How would you test the classification?",
    ],
    redFlags: [
      "Pages on every resource threshold.",
      "Calls all errors symptoms without checking the SLI.",
      "Has no route for cause signals.",
    ],
    rubric: [
      "Uses user impact as the dividing line.",
      "Handles the dependency case with a condition.",
      "Assigns a route to causes.",
      "Mentions testing the SLI.",
    ],
  },
  {
    id: "nightly-cpu",
    question:
      "The CPU alert pages every night at 2 a.m. and users are fine. What do you change, and what do you risk?",
    difficulty: 2,
    hints: [
      "The page has no user evidence.",
      "Removing the signal is not the same as removing the page.",
    ],
    answer:
      "I would move the CPU rule from the pager to a ticket or a dashboard and keep it owned by the team that can act on capacity. I would check whether the nightly batch is expected and whether the trend is approaching a real limit. The risk is that a genuine CPU problem which has not yet reached users will not wake anyone. I mitigate that by keeping a symptom alert on the SLO and by reviewing the trend during capacity planning. If CPU saturation can cause failures quickly, I would add a symptom alert on the latency or error budget rather than page on the cause.",
    followUps: [
      "What would make you keep the page?",
      "Who owns the ticket?",
      "How do you know the symptom alert will catch the failure?",
    ],
    redFlags: [
      "Deletes the alert without a replacement.",
      "Raises the threshold until it never fires.",
      "Keeps paging because CPU is usually important.",
    ],
    rubric: [
      "Separates page from signal.",
      "Names the risk of losing detection.",
      "Adds a symptom guardrail.",
      "Assigns ownership.",
    ],
  },
  {
    id: "symptom-blind-spot",
    question:
      "What can a symptom-only paging strategy miss, and how do you cover it?",
    difficulty: 3,
    hints: [
      "Symptoms depend on the SLI and the traffic path.",
      "Some failures are invisible to the current SLI.",
    ],
    answer:
      "Symptom-only paging can miss a cause that has not reached the measured path, a failure on a route excluded from the SLI, a low-traffic customer segment, or a data corruption that does not produce errors. It can also miss a dependency that is degrading before requests fail. I cover it with SLIs for the important user journeys, synthetic probes for paths without traffic, cause tickets with owners, and periodic review of the signals that are not paging. The point is not to page on everything; it is to make the coverage gaps explicit and decide which ones need a new symptom.",
    followUps: [
      "How do you find an unmeasured user journey?",
      "What is the role of synthetic monitoring?",
      "How would you page on data correctness?",
    ],
    redFlags: [
      "Claims symptom alerts cover everything.",
      "Ignores low-traffic paths.",
      "Adds cause pages instead of new symptoms.",
    ],
    rubric: [
      "Names concrete coverage gaps.",
      "Uses probes or new SLIs.",
      "Keeps cause tickets owned.",
      "Makes the gap explicit.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every paging rule is labeled symptom or cause and names the user signal it protects.",
      "The SLI covers the important user journeys, not only the healthiest route.",
      "Cause alerts have a ticket route, an owner, and a review expectation.",
      "The runbook starts with the symptom and links the cause panels.",
      "A synthetic probe covers paths with too little traffic to move the SLI quickly.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Start from the symptom and confirm the user impact.",
      "Open the cause panels only to explain the symptom, not to relitigate whether to page.",
      "Record which alerts fired and which were noise.",
      "Keep cause alerts out of the pager during the incident unless they change the response.",
      "Check whether the SLI is missing an affected segment.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Count the pages that led to action and the pages that did not.",
      "Move or delete the rules that produced no action.",
      "Add a symptom for any cause that reached users without one.",
      "Update the runbook link and the ownership metadata.",
    ],
  },
];

const references = [
  {
    title: "Alerting on SLOs",
    url: "https://sre.google/workbook/alerting-on-slos/",
    publisher: "Google SRE Workbook",
    kind: "book" as const,
    note: "Symptom-based paging, burn-rate alerts, and separating pages from diagnostics.",
  },
  {
    title: "Incident Response",
    url: "https://sre.google/sre-book/incident-response/",
    publisher: "Google SRE Book",
    kind: "book" as const,
    note: "Incident declaration, roles, and the signals that justify waking a responder.",
  },
  {
    title: "Alerts",
    url: "https://support.pagerduty.com/docs/alerts",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Alert creation, routing, and paging behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    symptoms: {
      model: symptomModel,
      presets,
      instructions:
        "Start Healthy, then apply Nightly CPU page. Compare the CPU rule with the SLO rule. Switch to Symptom only, then run the experiment and raise the CPU threshold.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Page counts per week are teaching values for a 99.9% error SLO and a 500ms latency target.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-slo-burn-rate",
    "observability-alert-fatigue",
    "observability-golden-signals",
    "foundations-use-red",
  ],
};
