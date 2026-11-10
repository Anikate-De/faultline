import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const HOURS_PER_SECOND = 2;

const params = [
  {
    id: "deadlineHours",
    label: "Applicable notification deadline",
    min: 24,
    max: 1440,
    step: 1,
    value: 72,
    unit: " hours",
    group: "Jurisdiction",
    help: "Deadline for the regime, recipient, and contract that apply: 24 hours for a strict contractual or sector rule, 72 hours for the GDPR supervisory-authority timeline, up to 1440 hours for a 60-day outer limit. Select it from the obligation, not from a default.",
    format: "count" as const,
  },
  {
    id: "detectionHours",
    label: "Suspicion to legal engagement",
    min: 0,
    max: 48,
    step: 1,
    value: 2,
    unit: " hours",
    group: "Triage",
    help: "Hours from the first credible suspicion to engaging legal, privacy, and the incident lead. The clock is about awareness and assessment, not about finishing the investigation.",
    format: "count" as const,
  },
  {
    id: "decisionHours",
    label: "Legal engagement to notification decision",
    min: 0,
    max: 72,
    step: 1,
    value: 20,
    unit: " hours",
    group: "Decision",
    help: "Hours from legal engagement to the decision to notify or to document why notification is not required. Fact gathering can continue after a phased notification.",
    format: "count" as const,
  },
  {
    id: "evidenceReadiness",
    label: "Required facts available at decision",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Record",
    help: "Share of the facts needed for the notification record: data categories, approximate people affected, containment status, likely consequences, and measures taken. Missing facts delay a defensible decision.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  deadline: number;
  detection: number;
  decision: number;
  readiness: number;
  lag: number;
  projectedOverrun: number;
  evidenceGap: number;
}

function compute(p: Params): Computed {
  const deadline = Math.round(clamp(num(p, "deadlineHours", 72), 24, 1440));
  const detection = Math.round(clamp(num(p, "detectionHours", 2), 0, 48));
  const decision = Math.round(clamp(num(p, "decisionHours", 20), 0, 72));
  const readiness = clamp(num(p, "evidenceReadiness", 100), 0, 100);
  const lag = detection + decision;
  return {
    deadline,
    detection,
    decision,
    readiness,
    lag,
    projectedOverrun: Math.max(0, lag - deadline),
    evidenceGap: 100 - readiness,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function overrunAt(elapsedHours: number, lag: number, deadlineHours: number): number {
  if (lag <= deadlineHours) return 0;
  return Math.max(0, Math.min(elapsedHours, lag) - deadlineHours);
}

function buildFrame(values: Computed, seed: number): SimFrame {
  const legalHealth = healthFor(values.detection, 4, 12);
  const evidenceHealth = healthFor(values.evidenceGap, 20, 50);
  return {
    t: 0,
    nodes: [
      {
        id: "detection",
        label: "Suspicion and triage",
        kind: "service",
        health: "ok",
        utilization: values.detection / 48,
        sublabel: `legal engaged at T+${values.detection}h`,
        detail: "The first credible signal that personal data may be affected. Triage has to start the assessment and engage legal; it does not need a confirmed root cause.",
      },
      {
        id: "legal",
        label: "Legal and privacy",
        kind: "mesh",
        health: legalHealth,
        utilization: values.detection / 48,
        sublabel: values.detection > 4 ? `engaged after ${values.detection}h` : "engaged within the target",
        detail: "The function that decides whether a notification obligation is triggered, which jurisdictions apply, and what can be said with confidence.",
      },
      {
        id: "assessment",
        label: "Scope and facts",
        kind: "worker",
        health: evidenceHealth,
        utilization: values.evidenceGap / 100,
        sublabel: `${values.readiness.toFixed(0)}% of required facts ready`,
        detail: "Data categories, approximate affected population, containment, likely consequences, and measures taken. A notification can be phased when facts are still developing.",
      },
      {
        id: "clock",
        label: "Notification clock",
        kind: "service",
        health: healthFor(values.projectedOverrun, 1, 24),
        utilization: Math.min(1, values.projectedOverrun / values.deadline),
        sublabel: `decision at T+${values.lag}h · ${values.deadline}h deadline`,
        detail: "The deadline that runs from awareness, not from the end of the investigation. The applicable value comes from the regime, recipient, and contract; the projected overrun is visible before the deadline arrives.",
      },
      {
        id: "regulator",
        label: "Regulator or affected people",
        kind: "external",
        health: "ok",
        utilization: 0.3,
        sublabel: "recipient and jurisdiction decide the deadline",
        detail: "The recipient depends on the regime and the facts: a supervisory authority, a health regulator, affected individuals, customers, or several of them.",
      },
      {
        id: "record",
        label: "Notification record",
        kind: "storage",
        health: evidenceHealth,
        utilization: values.evidenceGap / 100,
        sublabel: `${values.evidenceGap.toFixed(0)}% of facts missing`,
        detail: "The documented decision: what was known, what was not, who decided, which obligation applied, and when notice was given. It is evidence for both the regulator and the postmortem.",
      },
    ],
    edges: [
      edge("detection-legal", "detection", "legal", clamp(1 - values.detection / 48), legalHealth),
      edge("legal-assessment", "legal", "assessment", clamp(values.readiness / 100), evidenceHealth),
      edge("assessment-clock", "assessment", "clock", 1, healthFor(values.projectedOverrun, 1, 24)),
      edge("clock-regulator", "clock", "regulator", 1, "ok"),
      edge("assessment-record", "assessment", "record", clamp(values.readiness / 100), evidenceHealth),
      edge("legal-record", "legal", "record", 1, evidenceHealth),
    ],
    metrics: [
      metric("notification-lag", "Suspicion to notification decision", values.lag, " hours", undefined, undefined, "count"),
      metric("deadline-overrun", "Past the configured deadline", 0, " hours", 0.5, 1, "count"),
      metric("legal-latency", "Suspicion to legal engagement", values.detection, " hours", 4, 12, "count"),
      metric("evidence-gap", "Required facts missing at decision", values.evidenceGap, "%", 20, 50, "percent"),
      metric("projected-overrun", "Projected overrun at the current plan", values.projectedOverrun, " hours", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `The notification decision is planned at T+${values.lag}h against a ${values.deadline}-hour configured deadline; legal is engaged at T+${values.detection}h; ${values.evidenceGap.toFixed(0)}% of required facts are missing.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "deadline-overrun",
    metricId: "deadline-overrun",
    warn: 0.5,
    crit: 1,
    title: "The notification deadline passed during the investigation",
    cause:
      "The clock runs from awareness of a reportable incident, not from the end of the investigation. The deadline is a property of the regime, recipient, and contract, not a universal 72 hours. Waiting for a complete root cause, a final affected count, or a perfect message can consume whichever window applies. A phased notification is often allowed when facts are still developing; silence is not.",
    fix:
      "Engage legal at the first credible suspicion, start the notification record immediately, and identify the regime, recipient, and calculated deadline. Notify what is known, mark what is still being assessed, and update the record as facts arrive. Do not wait for containment to begin the clock analysis.",
    checkFirst: [
      "When did the team first have a credible suspicion, and who was told?",
      "Which regulation, contract, and jurisdiction apply, and what is the calculated deadline?",
      "Has a notification decision been recorded, even if the answer is not yet final?",
    ],
  },
  {
    id: "legal-latency",
    metricId: "legal-latency",
    warn: 4,
    crit: 12,
    title: "Legal was engaged too late",
    cause:
      "Engineering cannot decide alone whether an incident is reportable. Late engagement compresses the assessment, encourages an improvised decision, and can turn a manageable notification into a missed deadline. The delay is often caused by waiting for certainty that will not arrive quickly.",
    fix:
      "Give the incident process a legal and privacy contact with an escalation path, include them in the first incident call, and record the time of engagement. Triage for reportability in parallel with containment instead of after it.",
    checkFirst: [
      "Who is the legal or privacy contact, and how are they reached at 02:00?",
      "What time were they engaged relative to the first suspicion?",
      "Is reportability being assessed in parallel with containment?",
    ],
  },
  {
    id: "evidence-gap",
    metricId: "evidence-gap",
    warn: 20,
    crit: 50,
    title: "The notification decision rests on incomplete facts",
    cause:
      "A notification record needs the data categories, approximate affected population, containment status, likely consequences, and measures taken. If most of that is missing, the team either delays past the deadline or sends a notice it cannot defend. Both outcomes are avoidable with a phased, documented approach.",
    fix:
      "Capture the known facts as they arrive, state the uncertainty explicitly, and update the record. Assign owners for the missing facts and set a decision time that leaves room before the deadline. Do not let perfect facts block a timely notification.",
    checkFirst: [
      "Which required facts are missing, and who owns each one?",
      "Can the team notify with the facts it has and update later?",
      "Does the record state what was known at the time of the decision?",
    ],
  },
];

export const incidentNotificationModel: SimModel = {
  id: "compliance-incident-notification",
  visual: "timeline",
  params,
  init: ({ seed }) => buildFrame(compute(defaults()), seed),
  step: (frame, p, dt) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    const elapsedHours = (frame.t + dt) * HOURS_PER_SECOND;
    const overrun = overrunAt(elapsedHours, values.lag, values.deadline);
    const clockHealth = healthFor(overrun, 0.5, 1);
    next.metrics = next.metrics.map((item) =>
      item.id === "deadline-overrun" ? { ...item, value: overrun } : item,
    );
    next.nodes = next.nodes.map((node) =>
      node.id === "clock"
        ? {
            ...node,
            health: clockHealth,
            utilization: Math.min(1, overrun / values.deadline),
            sublabel: `T+${elapsedHours.toFixed(0)}h · decision at T+${values.lag}h`,
          }
        : node.id === "regulator"
          ? { ...node, health: clockHealth }
          : node,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (frame.flags.suspected !== 1) {
      pushEvent(next, {
        id: "suspected-incident",
        at: frame.t,
        severity: "warn",
        title: "Credible suspicion recorded",
        detail: "The notification clock starts from awareness of a possible reportable incident. Root cause and a final affected count are not prerequisites for engaging legal.",
        nodeId: "detection",
      });
      next.flags.suspected = 1;
    }
    if (elapsedHours >= values.detection && frame.flags.legalEngaged !== 1) {
      pushEvent(next, {
        id: "legal-engaged",
        at: frame.t,
        severity: values.detection > 12 ? "crit" : values.detection > 4 ? "warn" : "info",
        title: `Legal and privacy engaged at T+${values.detection}h`,
        detail: "Reportability, jurisdiction, and the recipient should be assessed in parallel with containment. The engagement time is part of the notification record.",
        nodeId: "legal",
      });
      next.flags.legalEngaged = 1;
    }
    if (elapsedHours >= values.deadline && frame.flags.deadlineReached !== 1) {
      pushEvent(next, {
        id: "notification-deadline",
        at: frame.t,
        severity: values.lag > values.deadline ? "warn" : "info",
        title: `T+${values.deadline}h notification deadline reached`,
        detail:
          values.lag > values.deadline
            ? `The planned notification decision is T+${values.lag}h, ${values.projectedOverrun.toFixed(0)}h past the ${values.deadline}h deadline. The record should already show what was known and why the decision was delayed.`
            : `The planned decision was T+${values.lag}h. The deadline passed with the decision recorded before it.`,
        nodeId: "clock",
        metricId: "deadline-overrun",
      });
      next.flags.deadlineReached = 1;
    }
    if (elapsedHours >= values.lag && frame.flags.decisionRecorded !== 1) {
      pushEvent(next, {
        id: "notification-decision",
        at: frame.t,
        severity: values.lag > values.deadline ? "crit" : "info",
        title: `Notification decision recorded at T+${values.lag}h`,
        detail:
          values.lag > values.deadline
            ? `${values.projectedOverrun.toFixed(0)} hours past the ${values.deadline}h deadline. Record the facts known at the time, the recipient, and the reason for the delay.`
            : `The decision was recorded before the ${values.deadline}h deadline with ${values.readiness.toFixed(0)}% of required facts available.`,
        nodeId: "record",
        metricId: "deadline-overrun",
      });
      next.flags.decisionRecorded = 1;
    }
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `At T+${elapsedHours.toFixed(0)}h the notification decision is planned for T+${values.lag}h against a ${values.deadline}h deadline; legal was engaged at T+${values.detection}h; ${values.evidenceGap.toFixed(0)}% of required facts are missing.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p);
    const elapsed = frame.t * HOURS_PER_SECOND;
    return [
      `The configured deadline is ${values.deadline}h and the planned decision is T+${values.lag}h. The projected overrun is ${values.projectedOverrun.toFixed(0)}h before the deadline even arrives.`,
      `Legal is engaged at T+${values.detection}h. A late engagement compresses the reportability assessment and is usually the reason a deadline is missed, not the final fact count.`,
      `${values.evidenceGap.toFixed(0)}% of required facts are missing. A phased notification can state what is known and what is still being assessed; waiting for perfect facts can consume the window.`,
      `At T+${elapsed.toFixed(0)}h, the simulated deadline overrun is ${overrunAt(elapsed, values.lag, values.deadline).toFixed(0)}h. The timeline records suspicion, legal engagement, the deadline, and the decision as separate events.`,
      "The presets use 24, 72, and 1440 hours to show a strict contractual window, the GDPR supervisory-authority timeline, and a 60-day outer limit. Those are examples, not universal values; jurisdiction, recipient, and facts change the real deadline, and this is not legal advice.",
    ];
  },
  legend: [
    { label: "On time", tone: "ok" },
    { label: "At risk", tone: "warn" },
    { label: "Late", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 72-hour deadline, legal engaged 2 hours after suspicion, the decision recorded at T+22h, and the required facts complete.",
    tone: "ok",
    params: defaults({ deadlineHours: 72, detectionHours: 2, decisionHours: 20, evidenceReadiness: 100 }),
  },
  {
    id: "peak",
    label: "Clock running",
    description: "A 24-hour contractual deadline, legal engaged at T+6h, and the decision at T+18h. The deadline is met with 6 hours of margin and some facts still missing.",
    tone: "warn",
    params: defaults({ deadlineHours: 24, detectionHours: 6, decisionHours: 12, evidenceReadiness: 80 }),
  },
  {
    id: "failure",
    label: "Wait for certainty",
    description: "A 24-hour deadline, legal engaged after eight hours, and a decision at T+78h. The preset opens at T+80h, 54 hours past the deadline.",
    tone: "crit",
    elapsed: 40,
    params: defaults({ deadlineHours: 24, detectionHours: 8, decisionHours: 70, evidenceReadiness: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A 60-day outer limit, legal engaged early, and the decision at T+20h, well inside the 1440-hour window.",
    tone: "ok",
    params: defaults({ deadlineHours: 1440, detectionHours: 2, decisionHours: 18, evidenceReadiness: 95 }),
  },
];

const experiment: Experiment = {
  id: "predict-clock",
  title: "Predict when the notification clock starts",
  simId: "incident-notification",
  question:
    "A breach is suspected at 02:00. The team wants to finish the investigation before engaging legal. The applicable deadline is 24 hours. What should happen first?",
  prediction: {
    options: [
      { id: "investigate", label: "Finish the investigation, then decide whether to notify" },
      { id: "engage", label: "Engage legal and start the notification record at the first credible suspicion" },
      { id: "contain", label: "Wait for containment, then start the clock" },
      { id: "customers", label: "Ask customers what deadline they want applied" },
    ],
    correctOptionId: "engage",
    explanation:
      "The clock runs from awareness, not from certainty. Legal and privacy should assess reportability, jurisdiction, and the recipient in parallel with containment. A phased notification can state what is known and what is still being assessed. Waiting for a complete root cause is how a 24-hour window disappears; a 72-hour or 60-day rule would give the same team more room, which is why the deadline must come from the obligation.",
  },
  setup: defaults({ deadlineHours: 24, detectionHours: 20, decisionHours: 60, evidenceReadiness: 40 }),
  runFor: 50,
  observe: [
    "Legal is engaged at T+20h, leaving only four hours before the 24-hour deadline.",
    "The deadline is reached at T+24h while the team is still assembling facts.",
    "The decision is recorded at T+80h, 56 hours late.",
    "The deadline-overrun metric crosses critical at about 13 simulated seconds.",
  ],
  explain:
    "The timeline separates four moments: suspicion, legal engagement, the deadline, and the decision. A late legal engagement pushes every later moment to the right. The team does not need a final affected count to start the record; it needs to document what it knows, who decided, and when. Phased updates are better than a single late notification, and the same decision can be early under a 60-day rule and late under a 24-hour one.",
  fix: defaults({ deadlineHours: 24, detectionHours: 2, decisionHours: 18, evidenceReadiness: 95 }),
  debrief:
    "With early engagement and a decision inside the configured window, the same incident is notified on time. The 24-hour value is one jurisdiction's or contract's rule; the lesson is to select the deadline from the obligation and then run the clock against it. The values are illustrative teaching values.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A notification timeline is the period between suspecting that an incident may affect personal data and telling the regulator, the affected people, or a customer. The deadline is not a single global number. The GDPR generally requires a controller to notify the supervisory authority without undue delay and, where feasible, within 72 hours of becoming aware, while allowing phased notification when not everything is known. HIPAA's Breach Notification Rule uses a 60-day outer limit after discovery, with different recipients and thresholds. Contracts can add shorter windows. The model exposes the deadline as a parameter: 24 hours for a strict contractual or sector rule, 72 hours for the GDPR supervisory-authority timeline, and 1440 hours for a 60-day outer limit.",
  },
  {
    type: "p",
    text: "The engineering failure is often not a missing regulation but an assumed deadline. Teams apply 72 hours everywhere, or wait for certainty, without asking which regime, recipient, and contract apply. The deadline can be 24 hours, 72 hours, or 60 days; the same facts can be early under one and late under another. The model makes that choice a parameter and computes the overrun against it. Legal engagement still happens in parallel, but the unique decision here is which clock the team is racing.",
  },
  {
    type: "p",
    text: "Notification also depends on a record. The team needs to show what was known at the time, which jurisdiction and recipient applied, who decided, and what was communicated. A perfect notification sent after the deadline is still late; a timely notification with clearly marked uncertainty can be updated. The model separates the deadline selected for the obligation, the legal engagement delay, the decision delay, and the completeness of the facts.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The timeline starts in detection and incident response, passes through legal and privacy, and ends at a regulator, a customer, or an affected person. Security and engineering own the facts: what data, which systems, how many records, what containment, and what evidence. Legal owns the obligation and the message. The incident lead owns the sequence and the record.",
  },
  {
    type: "table",
    headers: ["Moment", "Question", "What to record"],
    rows: [
      ["Suspicion", "When did we first have a credible signal?", "Time, source, incident channel, first responder"],
      ["Legal engagement", "Who is assessing reportability, and when?", "Contact, time, jurisdictions, recipient"],
      ["Deadline", "Which clock applies, and when does it end?", "Regime, trigger, calculated deadline"],
      ["Decision", "Notify or document why not?", "Facts known, uncertainty, decision maker, time"],
      ["Follow-up", "What changed after the first notice?", "New facts, updated count, supplemental notice"],
    ],
  },
  {
    type: "p",
    text: "The model exposes the deadline as a parameter because the same structure applies to a 24-hour contractual notice, a 72-hour supervisory-authority timeline, or a 60-day regulatory outer limit. Select the number from the obligation, keep the sequence.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Configured deadline: the value selected for the regime, recipient, and contract.",
      "Suspicion to legal engagement: the delay before the reportability assessment starts.",
      "Legal engagement to decision: the time spent gathering facts and deciding.",
      "Past the configured deadline: how many hours late the notification decision is.",
      "Required facts missing at decision: the completeness of the notification record.",
      "Timeline events: suspicion, legal engagement, deadline, and decision, replayed with the scrubber.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and watch the four timeline events arrive in order against a 72-hour deadline. Apply Clock running to see a 24-hour window with a thin margin, then Wait for certainty to open at T+80h with the deadline already missed. Run the experiment before revealing the explanation, then apply Recovery and compare a 1440-hour window.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. The 24, 72, and 1440-hour presets are illustrative. Real obligations vary by jurisdiction, recipient, data type, and contract, and legal must make the reportability and notification decisions.",
  },
  {
    type: "p",
    text: "The useful question is not whether the investigation is complete. It is whether the team recognized the clock, engaged the right people, and recorded a decision while there was still time to act on it.",
  },
  { type: "sim", simId: "incident-notification" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The timeline showed the deadline passing while the team was still assembling facts. Against a 24-hour deadline, legal engagement at T+20h left only four hours, and the decision at T+80h was 56 hours late. The overrun was visible before it happened because the planned decision time was compared with the configured deadline, not discovered after the fact.",
  },
  {
    type: "p",
    text: "The recovery preset did not produce a more complete investigation. It produced an earlier decision with 95% of the required facts, inside a 1440-hour window. The difference was the deadline selected for the obligation and the time at which the record was created.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Incident channel: first credible signal, time, and the person who raised it.",
      "Legal engagement: contact, escalation path, time, and jurisdictions.",
      "Clock: the applicable regime, trigger, recipient, and calculated deadline.",
      "Facts: data categories, approximate population, containment, consequences, and measures.",
      "Record: decision, uncertainty, communication, and later updates.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "Record the time of first credible suspicion, not the time of confirmation.",
      "Engage legal and privacy in parallel with containment.",
      "Identify the applicable regime, recipient, and deadline before drafting.",
      "List the facts you have and the facts you are missing.",
      "Decide whether a phased notification is possible, and record the decision.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Put legal and privacy on the first incident call with a 24/7 escalation path.",
      "Start a notification record at the first credible suspicion.",
      "Map jurisdiction and recipient before the facts are complete.",
      "Notify what is known, mark uncertainty, and set an update time.",
      "Preserve evidence and log every decision with a timestamp.",
      "Review the timeline after the incident and fix the delay that consumed the window.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Early notification protects the deadline but may share incomplete facts; phased updates manage that.",
      "Waiting for certainty improves the message and risks missing the window.",
      "A single global process is simpler but can apply the wrong deadline to the wrong jurisdiction.",
      "More legal involvement slows triage and reduces the chance of an improvised reportability decision.",
      "Detailed records support defensibility and add work during the most stressful part of the incident.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "clock-start",
    question: "When does a breach notification clock start?",
    difficulty: 2,
    hints: [
      "Awareness, not a completed root cause.",
      "The answer depends on the regime and the recipient.",
    ],
    answer:
      "It starts when the organization becomes aware of a incident that may trigger a notification obligation, not when the investigation is complete. Under the GDPR, the controller generally has 72 hours after awareness to notify the supervisory authority where feasible, and can notify in phases. HIPAA uses a 60-day outer limit after discovery for affected individuals, with different recipient rules. I would confirm the applicable regime, record the time of first credible suspicion, and engage legal immediately.",
    followUps: [
      "What counts as awareness when the first report is unconfirmed?",
      "How does a processor's clock relate to the controller's?",
      "What if the incident affects several jurisdictions?",
    ],
    redFlags: [
      "Says the clock starts at root cause.",
      "Applies one deadline everywhere.",
      "Waits for a final count.",
    ],
    rubric: [
      "Starts at awareness.",
      "Names regime differences.",
      "Records the time.",
      "Engages legal early.",
    ],
  },
  {
    id: "wait-for-facts",
    question: "The team wants to wait until it knows the exact number of affected people before notifying. What do you advise?",
    difficulty: 3,
    hints: [
      "Phased notification exists for a reason.",
      "State uncertainty rather than delay.",
    ],
    answer:
      "I would advise notifying with the facts available and clearly marking the estimate and the uncertainty, if the regime allows phased notification. The exact count can be updated later. Waiting for a precise number can consume the deadline and turn a timely, honest notice into a late one. I would record what was known, what was estimated, who decided, and when the next update is due.",
    followUps: [
      "What would you say in the first notice?",
      "How do you avoid contradicting yourself in the update?",
      "When would waiting be justified?",
    ],
    redFlags: [
      "Waits for a perfect count.",
      "Sends a notice without marking uncertainty.",
      "Has no update plan.",
    ],
    rubric: [
      "Uses phased notification.",
      "States uncertainty.",
      "Records the decision.",
      "Plans an update.",
    ],
  },
  {
    id: "jurisdiction",
    question: "How do you determine which notification deadline applies?",
    difficulty: 3,
    hints: [
      "Start with the people and the data, not the regulator you know best.",
      "Contracts can add obligations.",
    ],
    answer:
      "I would map the affected people, the data categories, and where the organization and the customers are established. Then legal can identify the regimes and recipients: a supervisory authority, a health regulator, affected individuals, or a customer under a contract. The contract may impose a shorter window than the regulation. I would record the trigger, the calculated deadline, and the responsible owner for each obligation instead of assuming one global number.",
    followUps: [
      "What if the customer contract is stricter than the law?",
      "Who decides that an incident is reportable?",
      "How do you track multiple deadlines without missing one?",
    ],
    redFlags: [
      "Uses one deadline for every incident.",
      "Ignores customer contracts.",
      "Lets engineering make the legal call alone.",
    ],
    rubric: [
      "Maps people, data, and establishment.",
      "Separates regimes and recipients.",
      "Includes contracts.",
      "Records deadlines and owners.",
    ],
  },
  {
    id: "late-decision",
    question: "The deadline has already passed when the team decides to notify. What now?",
    difficulty: 3,
    hints: [
      "Notify promptly and document the delay.",
      "Do not hide the lateness.",
    ],
    answer:
      "I would notify as soon as possible, explain the delay honestly, and document the facts known at the time, the reason for the delay, and the steps taken since. I would preserve the record and engage legal on supplemental notification and any regulator communication. Then I would run a postmortem on the process delay: when legal was engaged, who owned the decision, and what blocked it. The goal is to limit harm and prevent a repeat, not to reconstruct a timely decision.",
    followUps: [
      "What would you include in the explanation?",
      "How do you handle customers who learn before the regulator?",
      "Which process change would you make first?",
    ],
    redFlags: [
      "Suggests backdating the record.",
      "Hides the delay.",
      "Focuses only on the root cause.",
    ],
    rubric: [
      "Notifies promptly.",
      "Documents the delay honestly.",
      "Engages legal.",
      "Fixes the process delay.",
    ],
  },
];

const checklist = [
  {
    title: "First hour",
    items: [
      "Record the time and source of the first credible suspicion.",
      "Engage the incident lead, legal, and privacy.",
      "Preserve evidence and start the notification record.",
      "Identify the data categories and systems in scope.",
    ],
  },
  {
    title: "Before the deadline",
    items: [
      "Confirm the applicable regime, recipient, and deadline.",
      "List the facts known and the facts still missing.",
      "Decide whether a phased notification is allowed.",
      "Record the decision, the decision maker, and the time.",
    ],
  },
  {
    title: "After notification",
    items: [
      "Send supplemental updates when material facts change.",
      "Keep the regulator and customer communications consistent.",
      "Preserve the record and the evidence behind it.",
      "Review the delay that consumed the window and fix the process.",
    ],
  },
];

const references = [
  {
    title: "GDPR Article 33, Notification of a personal data breach",
    url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
    publisher: "European Union",
    kind: "standard" as const,
    note: "Official text on the 72-hour supervisory-authority notification and phased notification.",
  },
  {
    title: "HIPAA Breach Notification Rule",
    url: "https://www.hhs.gov/hipaa/for-professionals/breach-notification/index.html",
    publisher: "U.S. Department of Health and Human Services",
    kind: "docs" as const,
    note: "Official rule covering discovery, the 60-day outer limit, and notification recipients.",
  },
  {
    title: "NIST SP 800-61 Rev. 3, Incident Response Recommendations",
    url: "https://csrc.nist.gov/pubs/sp/800/61/r3/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Incident response lifecycle guidance including communication and stakeholder coordination.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "incident-notification": {
      model: incidentNotificationModel,
      presets,
      instructions:
        "Start Healthy and follow the timeline events. Apply Clock running and Wait for certainty, then compare the decision time with the deadline. Run the experiment before revealing the explanation, then apply Recovery and replay the timeline.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The deadline slider spans 24–1440 hours and the presets use 24, 72, and 1440. Real deadlines depend on jurisdiction, recipient, data, and contract, and this is not legal advice.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["reliability-legal", "compliance-gdpr", "compliance-hipaa"],
};
