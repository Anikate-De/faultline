import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, MAX_EVENTS, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TGW_ID = "tgw-0a1b2c3d4e5f67890";
const INTENDED_ACCOUNTS = 4;

const params = [
  {
    id: "sharedAccounts",
    label: "Accounts in the share",
    min: 1,
    max: 6,
    step: 1,
    value: 4,
    unit: "",
    group: "RAM share",
    help: "Number of participant accounts the owner includes in the resource share. Four are intended in this scenario.",
    format: "count" as const,
  },
  {
    id: "autoAccept",
    label: "Auto-accept attachments",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Owner control",
    help: "1 makes the transit gateway accept cross-account attachments automatically. 0 leaves each attachment pending until the owner accepts it.",
    format: "count" as const,
  },
  {
    id: "attachmentSlots",
    label: "Attachment capacity",
    min: 1,
    max: 8,
    step: 1,
    value: 4,
    unit: "",
    group: "Quota",
    help: "Illustrative owner-side attachment budget for this scenario, not the AWS default quota. The real attachments-per-gateway quota is published and adjustable.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  sharedAccounts: number;
  autoAccept: boolean;
  attachmentSlots: number;
  attached: number;
  pending: number;
  rejected: number;
  blocked: number;
  excess: number;
  coverage: number;
  ownerHealth: Health;
  shareHealth: Health;
  consumerHealth: Health;
  attachmentHealth: Health;
  routeHealth: Health;
}

function compute(p: Params): Computed {
  const sharedAccounts = Math.max(1, Math.round(num(p, "sharedAccounts", 4)));
  const autoAccept = num(p, "autoAccept", 1) >= 0.5;
  const attachmentSlots = Math.max(1, Math.round(num(p, "attachmentSlots", 4)));
  const accepted = Math.min(sharedAccounts, attachmentSlots);
  const rejected = Math.max(0, sharedAccounts - attachmentSlots);
  const attached = autoAccept ? accepted : 0;
  const pending = autoAccept ? 0 : accepted;
  const blocked = Math.max(0, INTENDED_ACCOUNTS - attached);
  const excess = Math.max(0, sharedAccounts - INTENDED_ACCOUNTS);

  return {
    sharedAccounts,
    autoAccept,
    attachmentSlots,
    attached,
    pending,
    rejected,
    blocked,
    excess,
    coverage: clamp((attached / INTENDED_ACCOUNTS) * 100, 0, 100),
    ownerHealth: pending > 0 ? "warn" : rejected > 0 ? "crit" : "ok",
    shareHealth: excess >= 2 ? "crit" : excess === 1 ? "warn" : "ok",
    consumerHealth: blocked > 0 || excess > 0 ? "warn" : "ok",
    attachmentHealth: rejected > 0 ? "crit" : pending > 0 ? "warn" : "ok",
    routeHealth: blocked > 0 ? "warn" : "ok",
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = item.value * (0.99 + 0.02 * Math.sin((index + (seed % 7)) / 2.6));
      return item.format === "percent" ? clamp(wave, 0, 100) : Math.max(0, wave);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  return {
    t: 0,
    nodes: [
      {
        id: "owner",
        label: `network account · ${TGW_ID}`,
        kind: "external",
        health: v.ownerHealth,
        sublabel: "transit gateway owner",
        detail:
          "The owner account owns the transit gateway, its attachments, and its route tables. Participants can attach their VPCs, but they cannot create, modify, or delete the gateway route tables, associations, or propagations.",
        meta: { view: "flow" },
      },
      {
        id: "share",
        label: "RAM resource share",
        kind: "mesh",
        health: v.shareHealth,
        sublabel: `${v.sharedAccounts} accounts · ${v.autoAccept ? "auto-accept" : "manual accept"}`,
        detail: v.autoAccept
          ? "Cross-account attachments are accepted automatically. The participant still needs its own VPC, subnet, and route table entry to the gateway."
          : "A participant can create an attachment, but it stays pending until the owner accepts it. The attachment is visible to both accounts while it waits.",
        meta: { view: "flow" },
      },
      {
        id: "consumers",
        label: "participant accounts",
        kind: "client",
        health: v.consumerHealth,
        sublabel: `${v.attached} attached · ${v.pending} pending · ${v.rejected} rejected`,
        detail: v.attached < INTENDED_ACCOUNTS
          ? `${v.blocked} intended accounts do not have a usable attachment. Check share acceptance, owner approval, and the gateway's attachment capacity before changing routes.`
          : "All four intended participants have a usable attachment. The owner still controls the gateway route table that decides where their traffic can go.",
        meta: { view: "flow" },
      },
      {
        id: "attachments",
        label: "VPC attachments",
        kind: "mesh",
        health: v.attachmentHealth,
        sublabel: `${v.attached} available · ${v.pending} pending · ${v.rejected} rejected`,
        detail: v.rejected > 0
          ? `${v.rejected} attachments were rejected because the share has more accounts than the gateway's illustrative attachment capacity. The owner must raise the quota or remove an account.`
          : v.pending > 0
            ? "The attachments exist in a pending state. No traffic flows until the owner accepts them, even though the participant has completed its side."
            : "Every shared account has an available attachment. The attachment consumes owner-side capacity and appears on the owner's gateway.",
        meta: { view: "flow" },
      },
      {
        id: "routes",
        label: "TGW route table",
        kind: "mesh",
        health: v.routeHealth,
        sublabel: v.attached < INTENDED_ACCOUNTS ? "return routes incomplete" : "owner-managed",
        detail:
          "The owner associates each attachment with a gateway route table and decides which CIDRs propagate. A participant cannot change these tables; it can only add a route in its own VPC subnet route table pointing at the shared gateway.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("owner-share", "owner", "share", 1, "ok"),
      edge(
        "share-consumers",
        "share",
        "consumers",
        clamp(v.sharedAccounts / 6),
        v.excess > 0 ? "warn" : "ok",
      ),
      edge(
        "consumers-attachments",
        "consumers",
        "attachments",
        clamp(v.attached / Math.max(1, v.sharedAccounts)),
        v.rejected > 0 ? "crit" : v.pending > 0 ? "warn" : "ok",
      ),
      edge(
        "attachments-routes",
        "attachments",
        "routes",
        clamp(v.attached / INTENDED_ACCOUNTS),
        v.blocked > 0 ? "warn" : "ok",
      ),
    ],
    metrics: [
      metric("attached-accounts", "Attached participants", v.attached, "", undefined, undefined, "count"),
      metric("pending-attachments", "Pending acceptance", v.pending, "", 1, 1, "count"),
      metric("rejected-attachments", "Rejected attachments", v.rejected, "", 1, 1, "count"),
      metric("blocked-participants", "Intended participants without attachment", v.blocked, "", 1, 2, "count"),
      metric("share-coverage", "Intended participants attached", v.coverage, "%", undefined, undefined, "percent"),
      metric("excess-accounts", "Accounts over the intended four", v.excess, "", 1, 2, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      autoAccept: v.autoAccept ? 1 : 0,
      sharedAccounts: v.sharedAccounts,
      slots: v.attachmentSlots,
    },
    summary: `${v.sharedAccounts} accounts shared; ${v.attached} attached; ${v.pending} pending; ${v.rejected} rejected; ${v.coverage.toFixed(0)}% of intended participants attached.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "pending-attachments",
    metricId: "pending-attachments",
    warn: 1,
    crit: 1,
    title: "A shared attachment is waiting for the owner",
    cause:
      "The transit gateway does not auto-accept cross-account attachments. The participant created the attachment, but it stays pending until an owner-side principal accepts it.",
    fix:
      "Accept the pending attachment in the owner account, or enable auto-accept on the transit gateway. Then associate it with the intended route table and verify the participant's VPC route.",
    checkFirst: [
      "Read the attachment state in both accounts: pendingAcceptance versus available.",
      "Check the gateway's auto-accept shared attachments setting.",
      "Confirm the participant's route table points at the shared gateway after acceptance.",
    ],
  },
  {
    id: "rejected-attachments",
    metricId: "rejected-attachments",
    warn: 1,
    crit: 1,
    title: "The shared gateway cannot take another attachment",
    cause:
      "The gateway's attachment capacity is exhausted, or the attachment cannot be created for another owner-side reason. The share is valid; the resource has a limit or a failed prerequisite.",
    fix:
      "Remove an unused attachment, request a quota increase, or split participants across gateways. Verify the VPC subnet has free IP addresses for the attachment network interfaces.",
    checkFirst: [
      "Count the attachments on the gateway against the published quota.",
      "Check the attachment state and reason in the owner account.",
      "Check that each participant subnet has available IP addresses.",
    ],
  },
  {
    id: "excess-accounts",
    metricId: "excess-accounts",
    warn: 1,
    crit: 2,
    title: "More accounts are in the share than intended",
    cause:
      "The resource share includes more participants than the four intended. Those accounts can create attachments and consume owner-side capacity even if the gateway route table does not route their traffic.",
    fix:
      "Remove the extra principals from the resource share and delete any attachments they created. Then review the gateway route table for associations that should not exist.",
    checkFirst: [
      "List the principals in the resource share, not only the attachments.",
      "Check for attachments owned by accounts outside the intended four.",
      "Review route table associations on the shared gateway.",
    ],
  },
  {
    id: "blocked-participants",
    metricId: "blocked-participants",
    warn: 1,
    crit: 2,
    title: "An intended participant has no usable attachment",
    cause:
      "The share contains fewer than four accounts, the owner has not accepted the attachment, or the gateway rejected it. The participant may have a route that points at a gateway it cannot use yet.",
    fix:
      "Confirm the account is in the share, check the attachment state, and accept or repair it in the owner account. Then verify the gateway route table association and the participant VPC route.",
    checkFirst: [
      "Compare the share principals with the four intended accounts.",
      "Read the attachment state: pending, available, rejected, or failed.",
      "Check the participant's VPC route table after the attachment is available.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const ramModel: SimModel = {
  id: "cloud-networking-ram",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p) => {
    const v = compute(p);
    const previous = {
      autoAccept: Number(frame.flags.autoAccept ?? 1),
      sharedAccounts: Number(frame.flags.sharedAccounts ?? 4),
      slots: Number(frame.flags.slots ?? 4),
    };
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events].slice(-MAX_EVENTS);
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, values]) => [key, [...values]]),
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (previous.autoAccept === 1 && !v.autoAccept) {
      pushEvent(next, {
        id: "auto-accept-disabled",
        at: frame.t,
        severity: "warn",
        title: "Shared attachments now require owner approval",
        detail:
          "Participants can still create attachments, but each one stays pending until an owner-side principal accepts it. Check the owner account before debugging the participant's route table.",
        nodeId: "attachments",
        metricId: "pending-attachments",
      });
    }
    if (previous.autoAccept === 0 && v.autoAccept) {
      pushEvent(next, {
        id: "auto-accept-enabled",
        at: frame.t,
        severity: "info",
        title: "Shared attachments are auto-accepted",
        detail:
          "New cross-account attachments no longer wait for manual approval. The owner's route table association still decides whether the attachment can route traffic.",
        nodeId: "attachments",
        metricId: "share-coverage",
      });
    }
    if (previous.sharedAccounts !== v.sharedAccounts) {
      pushEvent(next, {
        id: "share-principals-change",
        at: frame.t,
        severity: v.excess > 0 ? "crit" : "info",
        title: v.excess > 0 ? "Share includes more accounts than intended" : "Share principal count changed",
        detail: `${v.sharedAccounts} accounts are in the share; ${INTENDED_ACCOUNTS} are intended. Extra principals can create attachments and consume owner-side capacity.`,
        nodeId: "share",
        metricId: "excess-accounts",
      });
    }
    if (previous.slots !== v.attachmentSlots) {
      pushEvent(next, {
        id: "attachment-capacity-change",
        at: frame.t,
        severity: v.rejected > 0 ? "crit" : "info",
        title: v.rejected > 0 ? "Gateway attachment capacity exhausted" : "Gateway attachment capacity changed",
        detail: `${v.attachmentSlots} attachment slots are available for ${v.sharedAccounts} shared accounts. ${v.rejected} attachments are rejected.`,
        nodeId: "attachments",
        metricId: "rejected-attachments",
      });
    }
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (v.rejected > 0) {
      items.push(
        `${v.sharedAccounts} accounts are in the share, but the gateway can accept ${v.attachmentSlots} attachments. ${v.rejected} participants are rejected; the failure is owner-side capacity, not a bad participant route.`,
      );
    } else if (v.pending > 0) {
      items.push(
        `${v.pending} attachments are pending acceptance. The participant has completed its side, but no traffic flows until the owner accepts the attachment and associates it with a route table.`,
      );
    } else if (v.excess > 0) {
      items.push(
        `${v.sharedAccounts} accounts are in the share, one more than intended. The extra account can create an attachment even if the gateway route table does not route its CIDR.`,
      );
    } else {
      items.push(
        `All ${INTENDED_ACCOUNTS} intended participants have an available attachment and the share contains exactly those accounts.`,
      );
    }
    items.push(
      "The owner keeps the gateway route tables, associations, propagations, and attachment quota. A participant can create and delete its own VPC attachment, but it cannot change how the hub routes traffic.",
    );
    items.push(
      "Unsharing a transit gateway does not delete existing attachments. The attachment can stay functional, the participant loses the ability to describe the gateway, and the owner can still delete the attachment.",
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
    label: "Four accounts",
    description: "One share, four intended participants, auto-accept on, and enough attachment capacity.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "One extra account",
    description: "Five accounts share the gateway; all attach, but one is outside the intended set.",
    tone: "warn",
    params: defaults({ sharedAccounts: 5, attachmentSlots: 5 }),
  },
  {
    id: "failure",
    label: "Capacity exhausted",
    description: "Five accounts share a gateway with capacity for two attachments; three are rejected.",
    tone: "crit",
    params: defaults({ sharedAccounts: 5, attachmentSlots: 2, autoAccept: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Capacity and share membership are restored to the four intended accounts.",
    tone: "ok",
    params: defaults({ sharedAccounts: 4, attachmentSlots: 4, autoAccept: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-pending-attachment",
  title: "Predict the attachment state",
  simId: "ram-attachments",
  question:
    "The owner shares a transit gateway with four accounts, and auto-accept shared attachments is off. A participant creates a VPC attachment and adds a route to the gateway. What happens?",
  prediction: {
    options: [
      { id: "available", label: "The attachment is available immediately because the share was accepted." },
      { id: "pending", label: "The attachment stays pending until the owner accepts it, so traffic does not flow." },
      { id: "rejected", label: "The attachment is rejected because participants cannot create attachments." },
      { id: "routes", label: "The attachment works, but only after the participant edits the gateway route table." },
    ],
    correctOptionId: "pending",
    explanation:
      "Sharing the gateway lets the participant create an attachment. With auto-accept off, the attachment is created in a pending state and the owner must accept it. The participant cannot accept its own attachment or edit the gateway route table.",
  },
  setup: defaults({ sharedAccounts: 4, autoAccept: 0, attachmentSlots: 4 }),
  runFor: 15,
  observe: [
    "Four attachments exist, but all are pending.",
    "Zero participants have a usable attachment and coverage is 0%.",
    "No attachment is rejected; capacity is not the problem.",
    "The participant's VPC route points at the gateway, but no traffic flows.",
    "The owner account is the only place where the attachment can be accepted.",
  ],
  explain:
    "A RAM share grants the participant access to the resource, not automatic approval of every attachment. The transit gateway's auto-accept setting controls whether cross-account attachments become available without an owner action. With auto-accept off, the owner must accept each attachment, then associate it with a gateway route table. The participant cannot modify those tables.",
  fix: defaults({ sharedAccounts: 4, autoAccept: 1, attachmentSlots: 4 }),
  debrief:
    "The participant did its part correctly. The attachment was created, the VPC route existed, and the share was accepted. The missing step was owner-side acceptance. In production, decide deliberately whether auto-accept matches your review process; convenience and control are the tradeoff.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "AWS Resource Access Manager (RAM) shares supported resources across accounts, organizational units, or an organization. You create a resource share, add the resource, choose a managed permission, and list the principals. The resource owner retains ownership; the participant gets access to use the resource without a copy and without joining the owner's account.",
  },
  {
    type: "p",
    text: "A transit gateway is a shareable resource. The owner shares the gateway, and a participant can create a VPC attachment to it from its own account. The participant supplies its VPC, subnets, and a route in its own subnet route table. The owner keeps the gateway route tables, associations, propagations, and the attachment capacity. A participant cannot create, modify, or delete those owner-side objects.",
  },
  {
    type: "p",
    text: "That split is the point of RAM. The resource is not cloned and the accounts are not merged. The owner can see who has access and can revoke the share; the participant can attach its VPC and delete its own attachment. The two accounts cooperate on one gateway without sharing credentials or billing identities.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The owner creates the share in the same Region as the gateway. A participant in the same organization can receive access without an invitation when organization sharing is enabled; an account outside the organization accepts an invitation. The participant then creates a VPC attachment, and the owner either accepts it or relies on the gateway's auto-accept setting. Finally, the owner associates the attachment with a route table and decides which CIDRs propagate.",
  },
  {
    type: "table",
    headers: ["Action", "Owner", "Participant"],
    rows: [
      ["Create or update the resource share", "Yes", "No"],
      ["Create a VPC attachment to the shared gateway", "Yes", "Yes, for its own VPC"],
      ["Accept a pending attachment", "Yes", "No"],
      ["Create or modify gateway route tables", "Yes", "No"],
      ["Add a route in its own VPC subnet table", "Yes", "Yes"],
      ["Delete its own attachment", "Yes", "Yes"],
      ["Describe the gateway while the share exists", "Yes", "Yes"],
      ["Describe the gateway after the share is removed", "Yes", "No"],
    ],
  },
  {
    type: "p",
    text: "AWS publishes a default quota for attachments per transit gateway, and it is adjustable. This demo uses a small illustrative attachment capacity so the failure is visible; it is not the AWS default. The real quota applies to the gateway, so every participant attachment consumes owner-side capacity even though the participant created it.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Accounts in the share and the intended four participants.",
      "Auto-accept on or off, which decides whether an attachment becomes available without the owner.",
      "Available, pending, and rejected attachments, with coverage of the intended participant set.",
      "Attachment capacity as an illustrative owner-side limit, and the excess accounts beyond the intended set.",
      "The owner-managed route table, which stays outside the participant's control.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with four accounts and auto-accept on. Turn auto-accept off and watch every attachment become pending without being rejected. Restore it, then lower the attachment capacity and watch the excess attachments fail for a different reason. Finally, add a fifth account to see over-sharing without a capacity failure.",
  },
  {
    type: "p",
    text: "Four intended accounts and an attachment capacity of four to eight are illustrative teaching values. The share mechanics, owner and participant permissions, acceptance states, and quota behavior follow AWS documentation.",
  },
  { type: "sim", simId: "ram-attachments" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With auto-accept off, the participants created attachments and the owner saw them, but every attachment stayed pending. Nothing was rejected and the share was valid. The missing action was owner-side acceptance, followed by route table association.",
  },
  {
    type: "p",
    text: "Lowering the attachment capacity produced a different state. Some attachments were accepted and the rest were rejected because the gateway could not take them. The participants could not fix this from their accounts; the limit belonged to the shared resource.",
  },
  {
    type: "p",
    text: "Adding a fifth account produced a third state. Five attachments could be available, but one participant was outside the intended set. The gateway was healthy and the extra attachment consumed capacity that the four intended accounts might need.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "The RAM console shows the resource share, its principals, and the shared gateway. The participant sees the gateway in its VPC console with the owner account ID.",
      "The attachment state is the first signal. Pending acceptance is an owner action; rejected or failed is a capacity or prerequisite problem.",
      "A participant can create an attachment but cannot accept it, associate it with a gateway route table, or change propagation. Those remain owner operations.",
      "A participant's VPC route table must point at the shared gateway. The route can exist while the attachment is pending, but no traffic flows until the attachment is available.",
      "Unsharing does not necessarily stop existing traffic. The attachment can remain functional, the participant loses the ability to describe the gateway, and the owner can delete the attachment.",
      "A Site-to-Site VPN attachment must be created in the account that owns the gateway. A Direct Connect gateway attachment can involve a different account, but the association still belongs to the gateway owner.",
      "Attachment-hour and data-processing charges follow ownership. The participant pays for the attachment it owns; the owner pays for the gateway and the network components it owns.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the attachment state in both accounts. Pending means owner acceptance. Rejected or failed means capacity or a prerequisite. Available but unreachable means the gateway route table, association, or the participant's VPC route. Do not ask the participant to edit a table it does not own.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the share is accepted and the gateway appears in the participant account.",
      "Check the attachment state: pending, available, rejected, or failed.",
      "For pending, accept the attachment in the owner account or enable auto-accept deliberately.",
      "For rejected or failed, check the gateway's attachment quota, the participant subnet's free IP addresses, and the share principals.",
      "Associate the attachment with the intended gateway route table and enable the propagations the participant needs.",
      "Add the participant VPC route to the shared gateway and test in both directions.",
      "Remove extra principals and unused attachments so the owner-side capacity matches the intended set.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Auto-accept reduces onboarding work but removes the owner's review point. Manual acceptance keeps control but adds a step that can be forgotten under pressure.",
      "One shared gateway centralizes policy and cost, but its attachment quota and route tables become shared dependencies. Multiple gateways reduce blast radius and add operational overhead.",
      "Sharing with the organization simplifies access, but every current and future account can create attachments. Named accounts are narrower and require a change for each new participant.",
      "The owner keeps route policy, which gives consistency and limits participant autonomy. Participants may prefer their own gateway for control, at the cost of duplicate infrastructure.",
      "Unsharing looks like an immediate revocation, but existing attachments can remain functional. Removing access requires deleting or rejecting the attachment as a separate action.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "four-account-tgw",
    question:
      "Four accounts need to use one transit gateway owned by a network account. How do you share it, and which controls stay with the owner?",
    difficulty: 2,
    hints: [
      "The share and the attachment are separate steps.",
      "The owner keeps the route tables.",
    ],
    answer:
      "The network account creates a RAM resource share containing the transit gateway and lists the four participant accounts or a dedicated OU. Each participant accepts the share if needed, creates a VPC attachment from its own account, and adds a VPC route table entry pointing at the shared gateway. The owner accepts the attachments or enables auto-accept, then associates each attachment with the intended gateway route table and enables propagation. The owner keeps the gateway, its route tables, associations, propagations, and the attachment quota. Participants can create and delete their own attachments but cannot change how the hub routes traffic. I would use named accounts rather than the whole organization and monitor the share principals.",
    followUps: [
      "What changes if a participant is outside the organization?",
      "How would you isolate two participants on the same gateway?",
      "What happens if the owner unshares the gateway?",
    ],
    redFlags: [
      "Says the participant can edit the gateway route table.",
      "Shares with the whole organization without a reason.",
      "Forgets the VPC route table entry.",
    ],
    rubric: [
      "Creates a resource share with named principals.",
      "Separates attachment from route table association.",
      "States owner-only route controls.",
      "Mentions acceptance or auto-accept.",
    ],
  },
  {
    id: "pending-attachment",
    question:
      "A participant created a VPC attachment to a shared transit gateway, but traffic does not flow. The attachment is not rejected. What do you check?",
    difficulty: 2,
    hints: [
      "Not rejected does not mean available.",
      "The participant cannot accept it.",
    ],
    answer:
      "I would check the attachment state in both accounts. If it is pendingAcceptance, the owner has not accepted it; the participant cannot accept its own attachment. The owner either accepts it or enables auto-accept on the gateway. After acceptance, the owner must associate the attachment with a gateway route table and enable the needed propagation. The participant must also have a VPC route table entry pointing at the shared gateway. If the state is available, I would check the gateway route table and the participant route rather than the share.",
    followUps: [
      "Where would you see the pending state?",
      "What if the attachment is available but the route is missing?",
      "Would auto-accept be appropriate here?",
    ],
    redFlags: [
      "Recreates the share first.",
      "Asks the participant to accept the attachment.",
      "Assumes available means routed.",
    ],
    rubric: [
      "Checks pendingAcceptance.",
      "Names the owner as the accepting party.",
      "Checks route table association and VPC route.",
      "Distinguishes acceptance from routing.",
    ],
  },
  {
    id: "unshare-semantics",
    question:
      "The owner removes a participant from the transit gateway resource share. Does traffic stop immediately? What still works, and what changes?",
    difficulty: 3,
    hints: [
      "The share and the attachment are different objects.",
      "The participant loses visibility first.",
    ],
    answer:
      "Not necessarily. AWS documents that when a transit gateway is unshared, an existing attachment remains functional. The participant can no longer describe the gateway, but the attachment can continue to carry traffic. The gateway owner or the share owner can delete the attachment. So unsharing is not an immediate traffic cutoff; it removes the participant's visibility and its ability to manage the shared resource, but it does not necessarily remove the attachment. To revoke connectivity, the owner must delete the attachment or remove the routes. I would verify the attachment state after the unshare and remove it explicitly if the goal is to stop traffic.",
    followUps: [
      "Who can delete the attachment after the unshare?",
      "How would you prove traffic stopped?",
      "What would you monitor during the change?",
    ],
    redFlags: [
      "Says unsharing deletes every attachment.",
      "Says traffic always stops immediately.",
      "Forgets the owner can still delete the attachment.",
    ],
    rubric: [
      "States that the attachment can remain functional.",
      "Names the visibility change.",
      "Requires explicit attachment deletion for revocation.",
      "Checks the result rather than assuming.",
    ],
  },
];

const checklist = [
  {
    title: "Before the share",
    items: [
      "The resource owner and the share owner are the same account, or the delegation is explicit.",
      "The participant set is named and reviewed; organization-wide sharing is justified.",
      "The gateway's attachment quota and current attachment count are known.",
      "The intended gateway route table and propagation rules are documented.",
      "Auto-accept is set deliberately, with an owner-side review or monitoring path.",
    ],
  },
  {
    title: "During onboarding",
    items: [
      "The participant accepts the share and sees the gateway in its own account.",
      "The participant creates the attachment from its own VPC and subnet.",
      "The owner accepts the attachment or confirms auto-accept worked.",
      "The owner associates the attachment with the correct route table.",
      "The participant adds its VPC route and tests traffic in both directions.",
    ],
  },
  {
    title: "After the change",
    items: [
      "The share principal set matches the intended participants.",
      "Every attachment is available and associated with the intended table.",
      "Unused attachments and extra principals are removed.",
      "The owner can revoke access by deleting the attachment, not only by unsharing.",
    ],
  },
];

const references = [
  {
    title: "Work with AWS Transit Gateway: shared transit gateways",
    url: "https://docs.aws.amazon.com/vpc/latest/tgw/working-with-transit-gateways.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Owner and participant operations, auto-accept, unshare behavior, and shared subnets.",
  },
  {
    title: "Transit gateways in AWS Transit Gateway",
    url: "https://docs.aws.amazon.com/vpc/latest/tgw/tgw-transit-gateways.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Sharing a gateway through RAM and attaching a participant VPC.",
  },
  {
    title: "AWS Transit Gateway quotas",
    url: "https://docs.aws.amazon.com/vpc/latest/tgw/transit-gateway-quotas.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Published attachments-per-gateway quota and other gateway limits.",
  },
  {
    title: "What is AWS Resource Access Manager?",
    url: "https://docs.aws.amazon.com/ram/latest/userguide/what-is.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Resource shares, principals, ownership, and organization sharing.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "ram-attachments": {
      model: ramModel,
      presets,
      instructions:
        "Start with four accounts and auto-accept on. Turn auto-accept off, then lower the attachment capacity, then add a fifth account to compare pending, rejected, and over-shared outcomes.",
      experimentIds: [experiment.id],
      note: "Illustrative attachment capacity. The real attachments-per-gateway quota is published by AWS and is adjustable.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-cross-account",
    "cloud-networking-peering-vs-tgw",
    "cloud-networking-route-propagation",
  ],
};
