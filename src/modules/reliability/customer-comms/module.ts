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
    id: "internalDetailPct",
    label: "Internal detail copied",
    min: 0,
    max: 100,
    step: 5,
    value: 5,
    unit: "%",
    group: "Content",
    help: "Share of the customer message taken from internal notes: host names, hypotheses, vendor names, or responder comments.",
    format: "percent",
  },
  {
    id: "workaroundCoveragePct",
    label: "Workaround coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Content",
    help: "Share of affected customers for whom the message names a usable workaround.",
    format: "percent",
  },
  {
    id: "messageCadenceMin",
    label: "Message interval",
    min: 5,
    max: 120,
    step: 5,
    value: 20,
    unit: " min",
    group: "Timing",
    help: "Minutes between customer messages before approval time is added to each cycle.",
    format: "number",
  },
  {
    id: "approvalDelayMin",
    label: "Approval delay",
    min: 0,
    max: 30,
    step: 1,
    value: 3,
    unit: " min",
    group: "Timing",
    help: "Time from draft to approved message. A long approval chain delays the first useful statement.",
    format: "number",
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
  internalDetail: number;
  workaround: number;
  cadence: number;
  approval: number;
  elapsed: number;
  cycle: number;
  sinceMessage: number;
  messages: number;
  clarity: number;
  ambiguity: number;
  trustGap: number;
  leak: number;
}

function compute(p: Params, elapsed: number): Computed {
  const internalDetail = clamp(num(p, "internalDetailPct", 5), 0, 100);
  const workaround = clamp(num(p, "workaroundCoveragePct", 90), 0, 100);
  const cadence = clamp(Math.round(num(p, "messageCadenceMin", 20)), 5, 120);
  const approval = clamp(Math.round(num(p, "approvalDelayMin", 3)), 0, 30);
  const cycle = Math.max(1, cadence + approval);
  const messages = Math.floor(elapsed / cycle);
  const sinceMessage = elapsed % cycle;
  const clarity = clamp(
    45 + workaround * 0.55 - internalDetail * 0.7 - Math.max(0, approval - 8) * 2,
    0,
    100,
  );
  const ambiguity = 100 - clarity;
  const trustGap = clamp(
    (100 - clarity) * 0.8 + Math.max(0, cycle - 40) * 0.6 + (messages === 0 ? 5 : 0),
    0,
    100,
  );
  return {
    internalDetail,
    workaround,
    cadence,
    approval,
    elapsed,
    cycle,
    sinceMessage,
    messages,
    clarity,
    ambiguity,
    trustGap,
    leak: internalDetail,
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
  const supportHealth = health(c.ambiguity, 30, 55);
  const customerHealth = health(c.trustGap, 20, 40);
  const channelHealth = health(c.ambiguity, 30, 55);
  return {
    t: 0,
    nodes: [
      {
        id: "incident",
        label: "Incident channel",
        kind: "worker",
        health: "ok",
        utilization: 0.5,
        sublabel: "technical source of truth",
        detail:
          "The incident channel holds raw hypotheses, names, and debug detail. It is not written for customers and should not be pasted into a customer message.",
        meta: { view: "flow" },
      },
      {
        id: "comms",
        label: "Communications owner",
        kind: "worker",
        health: c.approval > 15 ? "warn" : "ok",
        utilization: clamp(0.2 + c.approval / 60),
        sublabel: `${c.approval} min approval`,
        detail:
          "One owner turns confirmed state into a customer-facing message. A long approval chain delays the first statement and invites support to improvise.",
        meta: { view: "flow" },
      },
      {
        id: "support",
        label: "Support",
        kind: "service",
        health: supportHealth,
        utilization: clamp(c.ambiguity / 100),
        sublabel: `${c.ambiguity.toFixed(0)}% ambiguity`,
        detail:
          "Support repeats the approved message or invents one. High ambiguity means the message does not answer the question customers actually ask.",
        meta: { view: "flow" },
      },
      {
        id: "channels",
        label: "Email and in-app",
        kind: "external",
        health: channelHealth,
        utilization: clamp(c.ambiguity / 100),
        sublabel:
          c.messages > 0
            ? `${c.messages} message${c.messages === 1 ? "" : "s"} sent`
            : "nothing sent yet",
        detail:
          "Email, in-app banners, and account notices all carry the same approved content. They should not diverge from support's script.",
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
          "Customers need impact, a workaround, and the next update. Internal detail and speculation make the message harder to trust, even when it is timely.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("incident-comms", "incident", "comms", 1, "ok"),
      edge("comms-support", "comms", "support", clamp(c.clarity / 100), supportHealth),
      edge("comms-channels", "comms", "channels", clamp(c.clarity / 100), channelHealth),
      edge(
        "support-customers",
        "support",
        "customers",
        clamp(1 - c.trustGap / 100),
        customerHealth,
      ),
    ],
    metrics: [
      metric("ambiguity", "Message ambiguity", c.ambiguity, "%", 30, 55, "percent"),
      metric("trust-gap", "Customer trust gap", c.trustGap, "%", 20, 40, "percent"),
      metric(
        "internal-leak",
        "Internal detail in customer message",
        c.leak,
        "%",
        10,
        30,
        "percent",
      ),
      metric(
        "workaround-coverage",
        "Workaround coverage",
        c.workaround,
        "%",
        undefined,
        undefined,
        "percent",
      ),
      metric(
        "messages-sent",
        "Customer messages sent",
        c.messages,
        "",
        undefined,
        undefined,
        "count",
      ),
    ],
    events: [],
    series: {},
    flags: { seed, commsElapsed: c.elapsed, commsMessages: c.messages },
    summary: `${c.ambiguity.toFixed(0)}% message ambiguity; ${c.workaround.toFixed(0)}% workaround coverage; trust gap ${c.trustGap.toFixed(0)}%.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "ambiguity",
    metricId: "ambiguity",
    warn: 30,
    crit: 55,
    title: "The customer message does not answer the customer question",
    cause:
      "The message is long on internal detail and short on impact, workaround, or next update. Customers cannot tell what is broken, what to do, or when to check again.",
    fix: "Rewrite around three answers: what is affected, what the customer can do now, and when the next update arrives. Remove internal names, hypotheses, and details that do not change the customer's action.",
    checkFirst: [
      "Ask support which question customers repeat most.",
      "Check whether the message names a workaround and its limits.",
      "Check whether the next update time is explicit.",
    ],
  },
  {
    id: "trust-gap",
    metricId: "trust-gap",
    warn: 20,
    crit: 40,
    title: "Customers are losing confidence in the updates",
    cause:
      "The message is late, ambiguous, or contradictory. A customer who cannot act on an update stops reading them and starts escalating.",
    fix: "Send one clear message with impact, workaround, and next update. Correct earlier errors explicitly. Keep the same statement across support, email, and in-app channels.",
    checkFirst: [
      "Compare the customer message with what support is saying.",
      "Check whether a promised next update was missed.",
      "Check whether a previous message contained a wrong cause or ETA.",
    ],
  },
  {
    id: "internal-leak",
    metricId: "internal-leak",
    warn: 10,
    crit: 30,
    title: "Internal incident detail reached customers",
    cause:
      "Raw incident channel messages were pasted into a customer update. Host names, vendor names, hypotheses, and responder comments are now public and may be wrong or sensitive.",
    fix: "Stop using the incident channel as a customer template. Give support an approved statement and route follow-up questions to the communications owner. Review pasted messages for sensitive detail.",
    checkFirst: [
      "Read the last customer message and mark every internal-only detail.",
      "Check whether support has the approved statement or the raw channel.",
      "Check whether the leaked detail names a person, host, or vendor.",
    ],
  },
];

const experiment: Experiment = {
  id: "predict-raw-paste",
  title: "Predict the effect of pasting the incident channel",
  simId: "customer-comms",
  question:
    "Support is pasting raw incident channel messages into customer replies. The messages are timely and detailed. What is the main risk?",
  prediction: {
    options: [
      { id: "speed", label: "Customers receive information too quickly" },
      { id: "detail", label: "Internal detail and speculation reach customers and damage trust" },
      { id: "volume", label: "The messages are too short to be useful" },
      { id: "cost", label: "The incident channel becomes too expensive to run" },
    ],
    correctOptionId: "detail",
    explanation:
      "The incident channel is optimized for responders, not customers. It contains hypotheses, internal names, and unfinished reasoning that change minute to minute. Pasting it creates contradictions and can expose sensitive detail. Customers need impact, workaround, and next update, not the raw investigation.",
  },
  setup: defaults({
    internalDetailPct: 90,
    workaroundCoveragePct: 10,
    messageCadenceMin: 45,
    approvalDelayMin: 20,
  }),
  runFor: 40,
  observe: [
    "No approved customer message has been sent after 40 simulated minutes.",
    "Message ambiguity reaches 100% and the trust gap rises above 80%.",
    "Internal detail in the customer message reaches 90%.",
    "Workaround coverage is 10%, so most customers still do not know what to do.",
  ],
  explain:
    "The raw channel is not a customer message. It is timely, but it answers responder questions. Customers cannot act on hypotheses, and a detail that changes later becomes a contradiction. The fix is a short approved message with impact, workaround, and next update, plus a route for support questions.",
  fix: defaults({
    internalDetailPct: 0,
    workaroundCoveragePct: 100,
    messageCadenceMin: 10,
    approvalDelayMin: 2,
  }),
  debrief:
    "With internal detail removed, a real workaround, and a short approval loop, the same incident produces a clear message on time. Support stops improvising and customers know when the next update arrives.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Customer communication turns the current incident state into a message a customer can act on. It answers three questions: what is affected, what can I do now, and when will I hear more. It is not a summary of the incident channel, a technical postmortem, a place to speculate about the cause, or a promise of an estimated time to resolution (ETA) the team cannot hold.",
  },
  {
    type: "p",
    text: "The most common failure is not silence. It is copying the internal channel into a customer reply because it is fast and detailed. The internal channel is optimized for responders: it contains hypotheses, host names, vendor names, and unfinished reasoning. That content changes minute to minute, so a customer who receives it also receives contradictions.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Customer communication sits between the communications owner and every customer-facing channel: support replies, email, in-app banners, and account notices. It consumes confirmed state from incident command and produces one approved message. Support, marketing, and account teams repeat that message; they do not write their own version.",
  },
  {
    type: "table",
    headers: ["Message element", "Customer question", "Example"],
    rows: [
      ["Impact", "What can't I do?", "Checkout is failing for some customers in the EU."],
      ["Workaround", "What can I do now?", "Retry in a few minutes, or use the mobile app."],
      ["Next update", "When will I know more?", "Next update by 14:30 UTC."],
      ["Scope", "Does this affect me?", "Reads are unaffected; only new orders are failing."],
      [
        "Internal detail",
        "Not for customers",
        "Host names, hypotheses, vendor blame, responder names.",
      ],
    ],
  },
  {
    type: "p",
    text: "The values in this module are illustrative: a twenty-minute message interval, a three-minute approval, and ninety-percent workaround coverage. Real values depend on the incident and the audience. One simulated second represents one incident minute.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Message ambiguity: how much of the customer question the message leaves unanswered.",
      "Customer trust gap: the cost of late, vague, or contradictory updates.",
      "Internal detail in the customer message: the leak from the incident channel.",
      "Workaround coverage: how many affected customers have a next action.",
      "Customer messages sent: whether the approved statement is moving at all.",
    ],
  },
  {
    type: "compare",
    leftTitle: "Paste the incident channel",
    rightTitle: "Approved customer update",
    rows: [
      { label: "Source", left: "Raw responder notes", right: "Confirmed impact and workaround" },
      { label: "Tone", left: "Internal, provisional", right: "Customer-facing, stable" },
      { label: "Changes", left: "Every few minutes", right: "On the promised cadence" },
      { label: "Risk", left: "Leaks names and speculation", right: "May lag the technical detail" },
      { label: "Support", left: "Improvises from fragments", right: "Repeats one statement" },
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Raw channel paste. Watch internal detail and ambiguity rise while support loses a single approved statement. Apply Speculation to isolate content damage, then apply Recovery and compare workaround coverage with the trust gap. Run the experiment before revealing the answer.",
  },
  { type: "sim", simId: "customer-comms" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the experiment, support pasted the incident channel into customer replies. The messages were current, but they carried hypotheses, internal names, and unfinished reasoning. Customers could not tell what was confirmed, what they should do, or when the next update would arrive. Internal detail reached 90% of the message and workaround coverage was 10%.",
  },
  {
    type: "p",
    text: "Replacing the paste with one approved message changed the outcome. The message named the affected capability, gave a workaround, and promised the next update. Internal detail fell to zero, ambiguity fell to zero, and the trust gap closed. The technical incident was not over; the communication was no longer making it worse.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Support replies that quote host names, vendor names, or an unconfirmed cause.",
      "Customers asking the same question in different words because the update did not answer it.",
      "Different channels telling different stories about scope or timing.",
      "A correction message after an earlier cause or ETA turns out to be wrong.",
      "Responders pulled into customer threads to explain what support already sent.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the last customer message and mark every internal-only detail. Ask support which question it cannot answer from the approved statement. Compare the customer message with the status page and the support script. If they disagree, fix the source before sending another update.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop pasting the incident channel; give support an approved customer statement.",
      "State impact, workaround, and the next update time in the first message.",
      "Remove internal names, hypotheses, vendor blame, and responder comments.",
      "Set a short approval loop so the first message is not delayed by certainty.",
      "Keep support, email, and in-app channels on the same source text.",
      "Correct any earlier error explicitly rather than silently changing the story.",
      "Review customer messages after the incident for leaked detail and unanswered questions.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "An approved message is slower than a raw paste but stable and safe to repeat.",
      "A specific workaround helps customers act but may not cover every case; state its limits.",
      "A short approval loop speeds communication but can reduce review of sensitive detail.",
      "Internal detail can be useful to a specific customer, but it should come through a controlled briefing, not a public message.",
      "A frequent cadence keeps customers informed but consumes communications and support capacity.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "raw-paste",
    question: "Support is pasting raw incident channel messages to customers. What do you change?",
    difficulty: 2,
    hints: [
      "The incident channel is optimized for responders.",
      "Give support one approved statement and a route for questions.",
    ],
    answer:
      "I would separate the internal and customer channels and give support an approved statement with impact, workaround, and next update time. I would route follow-up questions to the communications owner instead of the responders. I would explain that raw messages contain hypotheses and internal names that change quickly, so they create contradictions and can expose sensitive detail.",
    followUps: [
      "How do you keep the statement current?",
      "What if support needs detail for one customer?",
      "Who approves the first message?",
    ],
    redFlags: [
      "Lets support keep using the raw channel because it is faster.",
      "Adds more people to the incident channel.",
      "Publishes internal names in a customer message.",
    ],
    rubric: [
      "Separates channels.",
      "Defines the message contents.",
      "Routes questions.",
      "Explains the harm.",
    ],
  },
  {
    id: "workaround",
    question: "There is no full workaround. What do you tell customers?",
    difficulty: 2,
    hints: ["A partial workaround is still useful.", "State the limits instead of implying a fix."],
    answer:
      "I would state what still works, what does not, and any partial workaround with its limits. I would give the next update time and avoid implying that the workaround is a full fix. If there is no workaround, I would say that directly and tell customers what to avoid or when to retry. Honest scope is more useful than an optimistic guess.",
    followUps: [
      "How do you phrase a partial workaround?",
      "What if the workaround has a cost?",
      "When do you remove the workaround from the message?",
    ],
    redFlags: [
      "Invents a workaround.",
      "Hides that the workaround is partial.",
      "Says there is nothing to share.",
    ],
    rubric: [
      "States what works.",
      "Bounds the workaround.",
      "Gives next update.",
      "Avoids false optimism.",
    ],
  },
  {
    id: "multiple-audiences",
    question:
      "How do you keep support, email, and account teams consistent during a fast incident?",
    difficulty: 3,
    hints: ["One source, derived summaries.", "The communications owner owns the source."],
    answer:
      "I would keep one approved source message with impact, workaround, and next update, and derive audience-specific summaries from it. Support gets the customer wording; account teams get the same facts plus escalation guidance. The communications owner updates the source at the promised cadence, and every channel points to it instead of writing its own version.",
    followUps: [
      "What belongs only in the account-team version?",
      "How do you handle a customer-specific question?",
      "Who resolves a disagreement between channels?",
    ],
    redFlags: [
      "Lets each team write its own message.",
      "Sends the raw channel to account teams.",
      "Updates channels at different times.",
    ],
    rubric: [
      "Uses one source.",
      "Derives audience summaries.",
      "Names an owner.",
      "Defines escalation.",
    ],
  },
  {
    id: "correction",
    question: "An earlier customer update named the wrong cause. How do you correct it?",
    difficulty: 2,
    hints: ["Correct explicitly.", "Do not silently replace the old message."],
    answer:
      "I would publish a correction that states what was wrong, what is now known, and what has not changed. I would not delete the old message or quietly replace it. I would update support and the other channels with the same correction, and I would explain in the postmortem why an unconfirmed cause reached customers.",
    followUps: [
      "How much detail does the correction need?",
      "Who approves a correction?",
      "How do you prevent the next one?",
    ],
    redFlags: [
      "Silently edits the old message.",
      "Repeats the wrong cause.",
      "Avoids mentioning the correction.",
    ],
    rubric: [
      "Corrects explicitly.",
      "States current facts.",
      "Aligns channels.",
      "Reviews the cause.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "A communications owner is named and separate from the responders.",
      "A customer message template covers impact, workaround, and next update.",
      "Support knows where the approved statement lives.",
      "Email, in-app, and account-team channels use the same source.",
      "The approval path is short enough for the first update.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Publish confirmed impact before a confirmed cause.",
      "Include a workaround and its limits, or say there is none.",
      "Give a specific next update time.",
      "Remove internal names, hypotheses, and vendor blame.",
      "Route support questions to the communications owner.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Read the customer messages for leaked internal detail.",
      "Compare support, email, and in-app wording for contradictions.",
      "Correct any earlier speculation explicitly.",
      "Check whether the approval path delayed the first useful message.",
      "Update the template and the approved-statement workflow.",
    ],
  },
];

const references = [
  {
    title: "External Communication Guidelines",
    url: "https://response.pagerduty.com/during/external_communication_guidelines/",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Customer-facing communication during an incident, including what to include and avoid.",
  },
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Communication roles and coordination during incident response.",
  },
  {
    title: "Incident communication",
    url: "https://www.atlassian.com/incident-management/incident-communication",
    publisher: "Atlassian",
    kind: "docs" as const,
    note: "Audience-specific updates and the cost of unclear communication.",
  },
];

export const customerCommsModel: SimModel = {
  id: "reliability-customer-comms",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const previous = Math.max(0, Number(frame.flags.commsElapsed ?? 0));
    const elapsed = previous + Math.max(0, dt);
    const c = compute(p, elapsed);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, elapsed, seed);
    next.t = frame.t;
    next.flags = {
      ...frame.flags,
      ...next.flags,
      commsElapsed: elapsed,
      commsMessages: c.messages,
    };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events].slice(-60);

    if (frame.events.length === 0) {
      pushEvent(next, {
        id: "comms-incident-declared",
        at: 0,
        severity: "info",
        title: "Incident declared; first customer message is being drafted",
        detail: `The first customer message is due after a ${c.cycle}-minute cycle, including ${c.approval} minutes of approval.`,
        nodeId: "comms",
      });
    }
    const previousMessages = Math.max(0, Number(frame.flags.commsMessages ?? 0));
    if (c.messages > previousMessages) {
      pushEvent(next, {
        id: `comms-message-${c.messages}`,
        at: frame.t,
        severity: "info",
        title: "Customer message sent",
        detail: `Impact is stated, workaround coverage is ${c.workaround.toFixed(0)}%, and the next message is promised in ${c.cycle} minutes.`,
        nodeId: "channels",
        metricId: "messages-sent",
      });
    }
    if (c.messages === 0 && c.elapsed >= 20 && frame.flags.commsSilentEvent !== 1) {
      pushEvent(next, {
        id: "comms-no-message",
        at: frame.t,
        severity: "warn",
        title: "No customer message has been sent",
        detail: `${c.elapsed.toFixed(0)} minutes after impact, the first approved message is still in review. Support has no customer wording to repeat.`,
        nodeId: "support",
        metricId: "trust-gap",
      });
      next.flags.commsSilentEvent = 1;
    }
    if (c.messages > 0) next.flags.commsSilentEvent = 0;
    if (c.leak >= 30 && frame.flags.commsLeakEvent !== 1) {
      pushEvent(next, {
        id: "comms-internal-leak",
        at: frame.t,
        severity: "crit",
        title: "Internal incident detail reached customers",
        detail: `${c.leak.toFixed(0)}% of the customer message is internal detail. Host names, hypotheses, and responder comments are not customer content.`,
        nodeId: "customers",
        metricId: "internal-leak",
      });
      next.flags.commsLeakEvent = 1;
    }
    if (c.leak < 30) next.flags.commsLeakEvent = 0;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const c = compute(p, Math.max(0, Number(frame.flags.commsElapsed ?? 0)));
    const items: string[] = [];
    items.push(
      `${c.messages} customer message${c.messages === 1 ? "" : "s"} sent. The last was ${c.sinceMessage.toFixed(0)} minutes ago against a ${c.cycle}-minute cycle.`,
    );
    items.push(
      `Message ambiguity is ${c.ambiguity.toFixed(0)}%. Workaround coverage is ${c.workaround.toFixed(0)}%, so ${(100 - c.workaround).toFixed(0)}% of affected customers still have no next action.`,
    );
    items.push(
      `Internal detail is ${c.internalDetail.toFixed(0)}% of the message and the trust gap is ${c.trustGap.toFixed(0)}%.`,
    );
    items.push(
      "Customers need impact, workaround, and next update. The incident channel is not a customer message, even when it is current.",
    );
    return items;
  },
  legend: [
    { label: "Clear update", tone: "ok" },
    { label: "Ambiguous", tone: "warn" },
    { label: "Trust gap", tone: "crit" },
    { label: "Raw channel leak", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description:
      "One approved message per cycle, 90% workaround coverage, and only 5% internal detail.",
    tone: "ok",
    params: defaults(),
    elapsed: 30,
  },
  {
    id: "peak",
    label: "Slow approval",
    description:
      "A ten-minute approval loop and a fifteen-point internal detail leak make the message late and muddy.",
    tone: "warn",
    params: defaults({
      internalDetailPct: 15,
      workaroundCoveragePct: 70,
      messageCadenceMin: 30,
      approvalDelayMin: 10,
    }),
    elapsed: 45,
  },
  {
    id: "failure",
    label: "Raw channel paste",
    description:
      "Support copies responder notes: 90% internal detail, almost no workaround coverage, and a long approval loop.",
    tone: "crit",
    params: defaults({
      internalDetailPct: 90,
      workaroundCoveragePct: 0,
      messageCadenceMin: 60,
      approvalDelayMin: 25,
    }),
    elapsed: 30,
  },
  {
    id: "speculation",
    label: "Speculation",
    description:
      "The message is on time but mostly internal detail and unconfirmed cause. Customers cannot act on it.",
    tone: "crit",
    params: defaults({
      internalDetailPct: 60,
      workaroundCoveragePct: 20,
      messageCadenceMin: 15,
      approvalDelayMin: 5,
    }),
    elapsed: 30,
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "Internal detail is removed, the workaround is complete, and a two-minute approval keeps the message current.",
    tone: "ok",
    params: defaults({
      internalDetailPct: 0,
      workaroundCoveragePct: 100,
      messageCadenceMin: 10,
      approvalDelayMin: 2,
    }),
    elapsed: 30,
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "customer-comms": {
      model: customerCommsModel,
      presets,
      instructions:
        "Start Healthy, then apply Raw channel paste. Watch internal detail and ambiguity rise while workaround coverage stays low. Apply Speculation to isolate content damage, then apply Recovery and compare the trust gap with workaround coverage. Run the experiment before revealing the answer.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One simulated second represents one incident minute; cadence and coverage values are teaching examples.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-roles",
    "reliability-status-pages",
    "reliability-comms-cadence",
    "reliability-incident-command",
  ],
};
