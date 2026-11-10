import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "firstUpdateMin",
    label: "Minutes to first update",
    min: 0,
    max: 60,
    step: 1,
    value: 5,
    unit: " min",
    group: "Timing",
    help: "How long after impact the status page says anything. Waiting for a root cause leaves customers without a statement.",
    format: "number",
  },
  {
    id: "updateCadenceMin",
    label: "Update cadence",
    min: 5,
    max: 120,
    step: 5,
    value: 20,
    unit: " min",
    group: "Timing",
    help: "Promised minutes between public updates. The promise holds even when there is no new cause.",
    format: "number",
  },
  {
    id: "speculationPct",
    label: "Speculation in updates",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Content",
    help: "Share of updates that name an unconfirmed cause, blame a provider, or estimate a fix time without evidence.",
    format: "percent",
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
  first: number;
  cadence: number;
  speculation: number;
  elapsed: number;
  sinceUpdate: number;
  updates: number;
  supportLoad: number;
  trustGap: number;
  ambiguity: number;
}

function compute(p: Params, elapsed: number): Computed {
  const first = clamp(Math.round(num(p, "firstUpdateMin", 5)), 0, 60);
  const cadence = clamp(Math.round(num(p, "updateCadenceMin", 20)), 5, 120);
  const speculation = clamp(num(p, "speculationPct", 0), 0, 100);
  const updates = elapsed < first ? 0 : 1 + Math.floor((elapsed - first) / cadence);
  const sinceUpdate = elapsed < first ? elapsed : (elapsed - first) % cadence;
  const supportLoad = clamp(
    15 + sinceUpdate * 1.2 + Math.max(0, first - 10) * 1.0 + (updates === 0 ? 10 : 0),
    0,
    100,
  );
  const trustGap = clamp(
    Math.max(0, sinceUpdate - cadence * 0.5) * 1.5 +
      speculation * 0.4 +
      Math.max(0, first - 10) * 1.2 +
      (updates === 0 ? 5 : 0),
    0,
    100,
  );
  const ambiguity = clamp(
    speculation * 0.7 + (updates === 0 ? 20 : 0) + Math.max(0, 20 - updates * 5),
    0,
    100,
  );
  return {
    first,
    cadence,
    speculation,
    elapsed,
    sinceUpdate,
    updates,
    supportLoad,
    trustGap,
    ambiguity,
  };
}

function health(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 7;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.97 + 0.05 * Math.sin((index + phase) / 2.4))),
    );
  }
}

function buildFrame(p: Params, elapsed: number, seed: number): SimFrame {
  const c = compute(p, elapsed);
  const pageHealth: Health =
    c.speculation >= 30 || c.sinceUpdate >= 30
      ? "crit"
      : c.speculation >= 10 || c.sinceUpdate >= 20
        ? "warn"
        : "ok";
  const supportHealth = health(c.supportLoad, 40, 65);
  const customerHealth = health(c.trustGap, 20, 40);
  return {
    t: 0,
    nodes: [
      {
        id: "incident",
        label: "Incident response",
        kind: "worker",
        health: "ok",
        utilization: 0.5,
        sublabel: "working the fault",
        detail:
          "The response team is working the technical fault. The status page is a separate communication task with its own owner.",
        meta: { view: "flow" },
      },
      {
        id: "page",
        label: "Status page",
        kind: "service",
        health: pageHealth,
        utilization: clamp(c.sinceUpdate / Math.max(1, c.cadence)),
        sublabel: `${c.sinceUpdate.toFixed(0)} min since update`,
        detail: `The page promises an update every ${c.cadence} minutes. It has published ${c.updates} update${c.updates === 1 ? "" : "s"} so far.`,
        meta: { view: "flow" },
      },
      {
        id: "support",
        label: "Support queue",
        kind: "service",
        health: supportHealth,
        utilization: clamp(c.supportLoad / 100),
        sublabel: `${c.supportLoad.toFixed(0)} load index`,
        detail:
          "Support load rises when the public page is older than what customers already know. Each contact asks for the same current status.",
        meta: { view: "flow" },
      },
      {
        id: "customers",
        label: "Customers",
        kind: "external",
        health: customerHealth,
        utilization: clamp(c.trustGap / 100),
        sublabel: `${c.trustGap.toFixed(0)}% trust gap`,
        detail:
          "Customers judge the page on whether it describes their impact and when the next information will arrive, not on whether the root cause is known.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("incident-page", "incident", "page", 1, pageHealth),
      edge("page-support", "page", "support", clamp(1 - c.supportLoad / 100), supportHealth),
      edge("page-customers", "page", "customers", clamp(1 - c.trustGap / 100), customerHealth),
    ],
    metrics: [
      metric("update-age", "Minutes since public update", c.sinceUpdate, " min", 20, 30, "number"),
      metric("support-load", "Support load index", c.supportLoad, "", 40, 65, "number"),
      metric("trust-gap", "Customer trust gap", c.trustGap, "%", 20, 40, "percent"),
      metric("speculation", "Speculative content", c.speculation, "%", 10, 30, "percent"),
      metric(
        "updates-published",
        "Updates published",
        c.updates,
        "",
        undefined,
        undefined,
        "count",
      ),
    ],
    events: [
      {
        id: "status-incident-declared",
        at: 0,
        severity: "info",
        title: "Incident declared; the page has not updated",
        detail:
          "Support is already receiving customer reports. No public statement has been published yet.",
        nodeId: "page",
      },
    ],
    series: {},
    flags: { seed, statusElapsed: c.elapsed, statusUpdates: c.updates },
    summary: `${c.sinceUpdate.toFixed(0)} min since the last public update; support load ${c.supportLoad.toFixed(0)}; trust gap ${c.trustGap.toFixed(0)}%.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "update-age",
    metricId: "update-age",
    warn: 20,
    crit: 30,
    title: "The public status page has gone quiet",
    cause:
      "The page is waiting for a confirmed root cause or a complete fix. Customers already know the service is failing, so silence does not preserve confidence; it transfers the explanation to support and social channels.",
    fix: "Publish what is known now: affected capability, customer-visible impact, workaround if one exists, and the next update time. Publish again at that time even if nothing has changed.",
    checkFirst: [
      "Compare the last public update with the promised time.",
      "Ask support what it is telling customers right now.",
      "Check whether the page is waiting for a cause that customers do not need.",
    ],
  },
  {
    id: "support-load",
    metricId: "support-load",
    warn: 40,
    crit: 65,
    title: "Support is absorbing the communication gap",
    cause:
      "Customers contact support because the public page is older than the incident. The same question arrives many times, and support has no approved current answer.",
    fix: "Give support the public statement and a route for questions. Update the page before briefing support, and keep one owner responsible for both.",
    checkFirst: [
      "Read the top support contacts and look for one repeated question.",
      "Compare the support statement with the public page.",
      "Check whether support is escalating to responders for status.",
    ],
  },
  {
    id: "trust-gap",
    metricId: "trust-gap",
    warn: 20,
    crit: 40,
    title: "Customers have stopped trusting the page",
    cause:
      "The page is late, vague, or speculative. A wrong cause or a missed update time damages trust more than a short update that says the impact is unchanged.",
    fix: "State known impact and the next update time. Correct any earlier speculation explicitly. Hold the next promise before adding detail.",
    checkFirst: [
      "Check whether the page describes customer impact or internal work.",
      "Check whether a previous update promised a time that passed.",
      "Check whether the page blamed a provider before confirmation.",
    ],
  },
  {
    id: "speculation",
    metricId: "speculation",
    warn: 10,
    crit: 30,
    title: "The status page is speculating about cause",
    cause:
      "An unconfirmed hypothesis, a provider name, or an estimated fix time reached the public page. If it changes, customers remember the contradiction more than the correction.",
    fix: "Separate confirmed facts from hypotheses. Publish confirmed impact and workaround; keep hypotheses in the incident channel until evidence supports them. Correct the record if a claim was wrong.",
    checkFirst: [
      "Check whether the stated cause is confirmed by evidence.",
      "Check whether a provider has acknowledged the issue.",
      "Check whether the page gives an ETA the team cannot support.",
    ],
  },
];

const experiment: Experiment = {
  id: "predict-first-update",
  title: "Predict the first useful status update",
  simId: "status-pages",
  question:
    "Customers are reporting failures, support is filling with the same question, and the team has no confirmed cause. What should the first public update say?",
  prediction: {
    options: [
      {
        id: "known",
        label:
          "Some customers cannot use the feature; we are investigating; next update in 15 minutes",
      },
      {
        id: "cause",
        label: "A database failover at our provider caused the outage; fix expected by 14:30",
      },
      { id: "green", label: "All systems are operational while we investigate isolated reports" },
      { id: "vague", label: "We are aware of an issue and will provide more information soon" },
    ],
    correctOptionId: "known",
    explanation:
      "The first update needs three things: confirmed customer impact, the current action, and a specific next update time. It does not need a cause. Naming an unconfirmed provider or an ETA creates a second failure when the guess changes.",
  },
  setup: defaults({ firstUpdateMin: 45, updateCadenceMin: 60, speculationPct: 30 }),
  runFor: 30,
  observe: [
    "The page has published nothing after 30 simulated minutes.",
    "Support load reaches its maximum before any public statement exists.",
    "The trust gap is critical while the cause is still unknown.",
    "Speculation in the eventual update adds damage on top of the delay.",
  ],
  explain:
    "Customers already know something is wrong. The page's job is to confirm what is known, set expectations for the next update, and stop support from improvising. Waiting for certainty delays the only message that can reduce uncertainty.",
  fix: defaults({ firstUpdateMin: 2, updateCadenceMin: 10, speculationPct: 0 }),
  debrief:
    "An early update with known impact and a real next time keeps the page useful. The cause can be added later. A missed update time is worse than a short update, so promise only what the team can hold.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A status page is a public statement of customer-visible impact and the next time information will change. It is not a debugging log and not a root-cause report. Its first job is to tell customers whether the thing they are trying to use is affected, what they can do in the meantime, and when to check again.",
  },
  {
    type: "p",
    text: "Customers usually learn about an outage before the page does, because they hit the failure directly or hear about it from support. When the page stays silent, the gap is filled by support, social posts, and guesses. An update that says the impact is unchanged is more useful than a polished explanation that arrives after the incident.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The status page sits between incident response and the public. It consumes the current confirmed state and publishes a deliberately narrow view: affected capabilities, customer impact, workaround, and the next update time. It does not publish internal hypotheses, individual names, unconfirmed provider blame, or an estimated time to resolution (ETA) the team cannot support.",
  },
  {
    type: "table",
    headers: ["Phase", "What the page says", "What it avoids"],
    rows: [
      ["Investigating", "Known impact and next update time", "A cause or a fix estimate"],
      [
        "Identified",
        "Confirmed cause at the level customers need",
        "Internal names and speculation",
      ],
      [
        "Monitoring",
        "Service restored, watching for recurrence",
        "Declaring success before the watch window",
      ],
      [
        "Resolved",
        "Duration, impact, and where the review will be published",
        "Blame or unverified detail",
      ],
    ],
  },
  {
    type: "p",
    text: "The timings in this module are illustrative: five minutes to the first update and twenty minutes between updates. The right cadence depends on impact and on how fast the situation changes, but the promise must be one the team can keep. One simulated second represents one incident minute in the model.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Minutes since the last public update, compared with the promised cadence.",
      "Support load: the repeated contacts created by an outdated page.",
      "Customer trust gap: how far the page is from what customers already know.",
      "Speculative content: cause, blame, or ETA published before confirmation.",
      "Updates published: whether the page is moving through phases or standing still.",
    ],
  },
  {
    type: "compare",
    leftTitle: "Wait for certainty",
    rightTitle: "Publish known impact",
    rows: [
      {
        label: "First update",
        left: "After diagnosis",
        right: "Minutes after impact is confirmed",
      },
      {
        label: "Content",
        left: "Cause and ETA, often wrong",
        right: "Impact, workaround, next time",
      },
      {
        label: "Support",
        left: "Improvises from the incident channel",
        right: "Repeats one approved statement",
      },
      {
        label: "Trust",
        left: "Damaged by silence and corrections",
        right: "Built by predictable updates",
      },
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Silent page. Watch support load and the trust gap rise while the page publishes nothing. Apply Speculative updates to see the damage from an unconfirmed cause, then apply Recovery and compare the update age with support load. Run the experiment before revealing the answer.",
  },
  { type: "sim", simId: "status-pages" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the experiment, the page waited 45 minutes before saying anything and then promised updates every hour. Customers did not wait. They contacted support, compared notes, and filled the gap with guesses. Support load reached its maximum before the first public statement existed, and the trust gap was already critical.",
  },
  {
    type: "p",
    text: "A two-minute first update with known impact and a ten-minute cadence kept the page current. The cause was still unknown at the first update; that was acceptable. The page promised information, not certainty, and it kept the promise.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Support contacts quoting an older status page than the incident channel.",
      "The same question repeated across tickets, chat, and social channels.",
      "A status page that describes internal work instead of customer impact.",
      "A missed next-update time with no correction or explanation.",
      "A public cause that changes after the provider or the team learns more.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the last public update with the promised time. Ask support what it is telling customers right now. Check whether the page states customer impact, a workaround, and a next update time, and whether any cause on the page is confirmed rather than assumed.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Name a status page owner separate from the technical responders.",
      "Publish the first update from confirmed impact; do not wait for a cause.",
      "State the next update time and hold it even when nothing has changed.",
      "Give support the same statement before or with the public update.",
      "Keep hypotheses in the incident channel until evidence supports them.",
      "Correct any earlier speculation explicitly rather than silently replacing it.",
      "Review promised times against actual timestamps after the incident.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "An early update reduces uncertainty but may be short on detail; that is usually the right trade.",
      "A tight cadence keeps the page current but consumes communication capacity during the response.",
      "Naming a cause can reassure customers when it is confirmed, and damage trust when it is not.",
      "A workaround may be partial or temporary; describing its limits is better than implying a full fix.",
      "A public ETA is useful only if the team can hold it; otherwise the next update time is the better promise.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "first-update",
    question: "What goes in the first status update when the cause is unknown?",
    difficulty: 1,
    hints: [
      "Customers need impact and timing, not your hypothesis.",
      "Include a workaround if one exists.",
    ],
    answer:
      "I would state the confirmed customer impact, which capabilities are affected, any known workaround, and the next time the page will update. I would not name a cause or an ETA without evidence. The first update establishes that the team knows about the impact and will keep the page current.",
    followUps: [
      "What if the impact is still being scoped?",
      "How specific should the next update time be?",
      "When do you move from investigating to identified?",
    ],
    redFlags: [
      "Waits for a root cause.",
      "Publishes an unconfirmed provider name.",
      "Gives no next update time.",
    ],
    rubric: [
      "States impact.",
      "Includes a workaround if known.",
      "Commits to a next update.",
      "Avoids speculation.",
    ],
  },
  {
    id: "missed-time",
    question: "The promised update time passed and the team has nothing new. What do you publish?",
    difficulty: 2,
    hints: ["The absence of news is itself information.", "Keep the promise visible."],
    answer:
      "I publish at the promised time with the impact unchanged, the current action, what has been ruled out if anything, and a new next update time. I do not skip the update because the technical picture has not changed. A held promise preserves trust; a silent missed promise invites support and customers to invent a story.",
    followUps: [
      "How do you avoid repeating the same message verbatim?",
      "What if the new time might also slip?",
      "How do you correct a previous estimate?",
    ],
    redFlags: ["Skips the update.", "Invents progress.", "Removes the next update time."],
    rubric: [
      "Publishes on time.",
      "States unchanged impact.",
      "Gives a new update time.",
      "Explains why silence is costly.",
    ],
  },
  {
    id: "speculation",
    question:
      "A responder thinks a cloud provider caused the outage. Do you put that on the status page?",
    difficulty: 2,
    hints: [
      "A hypothesis is not a confirmed cause.",
      "Provider blame has commercial and trust consequences.",
    ],
    answer:
      "Not until it is confirmed. I would keep the hypothesis in the incident channel and publish confirmed impact and workaround. If the provider later acknowledges the issue, I can name it with the evidence. If the hypothesis turns out wrong, a public correction damages trust more than the initial silence would have.",
    followUps: [
      "What counts as confirmation?",
      "How do you correct a wrong public cause?",
      "When is it appropriate to name a dependency?",
    ],
    redFlags: [
      "Publishes the responder's guess.",
      "Blames a provider to deflect.",
      "Never corrects a wrong claim.",
    ],
    rubric: [
      "Waits for confirmation.",
      "Keeps hypotheses internal.",
      "Defines confirmation.",
      "Plans a correction.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "A status page owner is named and reachable during incidents.",
      "Templates cover investigating, identified, monitoring, and resolved.",
      "The team knows which capabilities map to which customer-facing names.",
      "Support knows where to get the current approved statement.",
      "The first-update target and the normal cadence are written down.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Publish confirmed impact before a confirmed cause.",
      "State a specific next update time and hold it.",
      "Include a workaround when one exists, with its limits.",
      "Give support the same statement at the same time.",
      "Keep hypotheses, internal names, and provider blame off the page.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Compare promised update times with actual publication times.",
      "Review support contacts created by missing or outdated page content.",
      "Correct any earlier public speculation explicitly.",
      "Add the status timeline to the postmortem.",
      "Update templates and the cadence for the next exercise.",
    ],
  },
];

const references = [
  {
    title: "Incident communication",
    url: "https://www.atlassian.com/incident-management/incident-communication",
    publisher: "Atlassian",
    kind: "docs" as const,
    note: "Audience-specific incident updates and status communication practices.",
  },
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Communication roles and the cost of unclear incident updates.",
  },
];

export const statusPagesModel: SimModel = {
  id: "reliability-status-pages",
  visual: "timeline",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const previous = Math.max(0, Number(frame.flags.statusElapsed ?? 0));
    const elapsed = previous + Math.max(0, dt);
    const c = compute(p, elapsed);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, elapsed, seed);
    next.t = frame.t;
    next.flags = {
      ...frame.flags,
      ...next.flags,
      statusElapsed: elapsed,
      statusUpdates: c.updates,
    };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events].slice(-60);

    const previousUpdates = Math.max(0, Number(frame.flags.statusUpdates ?? 0));
    if (c.updates > previousUpdates) {
      pushEvent(next, {
        id: `status-update-${c.updates}`,
        at: frame.t,
        severity: "info",
        title: "Public update published",
        detail: `Impact is stated, a workaround is included where known, and the next update is promised in ${c.cadence} minutes.`,
        nodeId: "page",
        metricId: "update-age",
      });
    }
    if (c.updates === 0 && c.supportLoad >= 65 && frame.flags.statusSilentEvent !== 1) {
      pushEvent(next, {
        id: "status-silent-page",
        at: frame.t,
        severity: "crit",
        title: "The page is silent while support absorbs the incident",
        detail: `No public update has been published ${elapsed.toFixed(0)} minutes after impact. Support load is ${c.supportLoad.toFixed(0)}.`,
        nodeId: "support",
        metricId: "support-load",
      });
      next.flags.statusSilentEvent = 1;
    }
    if (c.updates > 0) next.flags.statusSilentEvent = 0;
    if (c.sinceUpdate >= 30 && c.updates > 0 && frame.flags.statusOverdueEvent !== 1) {
      pushEvent(next, {
        id: "status-overdue",
        at: frame.t,
        severity: "crit",
        title: "The promised update time passed",
        detail: `The last public update was ${c.sinceUpdate.toFixed(0)} minutes ago against a ${c.cadence}-minute promise.`,
        nodeId: "page",
        metricId: "update-age",
      });
      next.flags.statusOverdueEvent = 1;
    }
    if (c.sinceUpdate < 30) next.flags.statusOverdueEvent = 0;
    if (c.speculation >= 30 && frame.flags.statusSpeculationEvent !== 1) {
      pushEvent(next, {
        id: "status-speculation",
        at: frame.t,
        severity: "crit",
        title: "Speculation reached the public page",
        detail: `${c.speculation.toFixed(0)}% of updates contain an unconfirmed cause, provider blame, or an unsupported ETA.`,
        nodeId: "customers",
        metricId: "speculation",
      });
      next.flags.statusSpeculationEvent = 1;
    }
    if (c.speculation < 30) next.flags.statusSpeculationEvent = 0;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const c = compute(p, Math.max(0, Number(frame.flags.statusElapsed ?? 0)));
    const items: string[] = [];
    items.push(
      c.updates === 0
        ? `The page has published nothing ${c.elapsed.toFixed(0)} minutes after impact. The first update is set for ${c.first} minutes.`
        : `The page has published ${c.updates} update${c.updates === 1 ? "" : "s"}. The last one was ${c.sinceUpdate.toFixed(0)} minutes ago against a ${c.cadence}-minute promise.`,
    );
    items.push(
      `Support load is ${c.supportLoad.toFixed(0)} and the customer trust gap is ${c.trustGap.toFixed(0)}%. Both rise when the page is older than what customers already know.`,
    );
    items.push(
      c.speculation > 0
        ? `${c.speculation.toFixed(0)}% of the page content is speculative. A confirmed impact statement is more useful than an unconfirmed cause.`
        : "The page contains no speculative cause, provider blame, or unsupported ETA.",
    );
    items.push(
      "The first update needs confirmed impact and a next update time. It does not need a root cause.",
    );
    return items;
  },
  legend: [
    { label: "Page current", tone: "ok" },
    { label: "Update late", tone: "warn" },
    { label: "Trust gap", tone: "crit" },
    { label: "Page silent", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description:
      "The first update lands in five minutes and a new update follows every twenty minutes.",
    tone: "ok",
    params: defaults(),
    elapsed: 30,
  },
  {
    id: "peak",
    label: "Slow first update",
    description:
      "The page takes 15 minutes to speak and then updates every 30. Support load is at its warning limit.",
    tone: "warn",
    params: defaults({ firstUpdateMin: 15, updateCadenceMin: 30, speculationPct: 15 }),
    elapsed: 30,
  },
  {
    id: "failure",
    label: "Silent page",
    description:
      "The first update waits an hour and the cadence is two hours. Support invents its own answers.",
    tone: "crit",
    params: defaults({ firstUpdateMin: 60, updateCadenceMin: 120, speculationPct: 10 }),
    elapsed: 30,
  },
  {
    id: "speculative",
    label: "Speculative updates",
    description:
      "Updates arrive on time, but 45% of the content names an unconfirmed cause or provider.",
    tone: "crit",
    params: defaults({ firstUpdateMin: 8, updateCadenceMin: 15, speculationPct: 45 }),
    elapsed: 30,
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "A two-minute first update and a ten-minute cadence keep the page current through recovery.",
    tone: "ok",
    params: defaults({ firstUpdateMin: 2, updateCadenceMin: 10, speculationPct: 0 }),
    elapsed: 30,
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "status-pages": {
      model: statusPagesModel,
      presets,
      instructions:
        "Start Healthy, then apply Silent page. Watch support load and the trust gap rise while the page publishes nothing. Apply Speculative updates to isolate content damage from delay, then apply Recovery and compare the update age with support load.",
      experimentIds: [experiment.id],
      note: "Illustrative model. One simulated second represents one incident minute; update times and load indexes are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-customer-comms",
    "reliability-comms-cadence",
    "reliability-incident-command",
    "reliability-roles",
  ],
};
