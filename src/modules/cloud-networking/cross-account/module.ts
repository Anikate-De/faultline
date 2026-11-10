import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, MAX_EVENTS, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const INTENDED_ACCOUNTS = 5;
const ORG_ACCOUNTS = 12;
const OWNER_VPC = "vpc-0a1b2c3d4e5f67890";

const params = [
  {
    id: "accountsInShare",
    label: "Named accounts in the share",
    min: 1,
    max: 8,
    step: 1,
    value: 5,
    unit: "",
    group: "RAM share",
    help: "Number of accounts explicitly listed as principals in the RAM resource share. Ignored when the share targets the whole organization.",
    format: "count" as const,
  },
  {
    id: "shareScope",
    label: "Share with the organization",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "RAM share",
    help: "0 shares the subnet with the named accounts. 1 shares with every account in the organization, which is 12 accounts in this scenario.",
    format: "count" as const,
  },
  {
    id: "resourcePolicy",
    label: "Service policy allows any org account",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Resource policy",
    help: "0 allows only the five intended account principals. 1 uses a wildcard principal with an organization condition, so every account that can route to the service is authorized.",
    format: "count" as const,
  },
  {
    id: "networkAllow",
    label: "Owner network allows consumers",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Network",
    help: "1 means the owner's subnet ACL and service security group allow the shared subnet range. 0 blocks the network path even when the share and policy are correct.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  accountsInShare: number;
  shareScope: boolean;
  resourcePolicy: boolean;
  networkAllow: boolean;
  visibleAccounts: number;
  serviceAccounts: number;
  excessAccounts: number;
  blockedAccounts: number;
  reach: number;
  ownerHealth: Health;
  shareHealth: Health;
  consumerHealth: Health;
  policyHealth: Health;
  serviceHealth: Health;
}

function compute(p: Params): Computed {
  const accountsInShare = Math.max(1, Math.round(num(p, "accountsInShare", 5)));
  const shareScope = num(p, "shareScope", 0) >= 0.5;
  const resourcePolicy = num(p, "resourcePolicy", 0) >= 0.5;
  const networkAllow = num(p, "networkAllow", 1) >= 0.5;
  const visibleAccounts = shareScope ? ORG_ACCOUNTS : accountsInShare;
  const serviceAccounts = !networkAllow
    ? 0
    : resourcePolicy
      ? visibleAccounts
      : Math.min(visibleAccounts, INTENDED_ACCOUNTS);
  const excessAccounts = Math.max(0, Math.max(visibleAccounts, serviceAccounts) - INTENDED_ACCOUNTS);
  const blockedAccounts = Math.max(0, INTENDED_ACCOUNTS - serviceAccounts);
  const reach = clamp((serviceAccounts / INTENDED_ACCOUNTS) * 100, 0, 100);

  return {
    accountsInShare,
    shareScope,
    resourcePolicy,
    networkAllow,
    visibleAccounts,
    serviceAccounts,
    excessAccounts,
    blockedAccounts,
    reach,
    ownerHealth: "ok",
    shareHealth: excessAccounts >= 2 ? "crit" : excessAccounts === 1 || blockedAccounts > 0 ? "warn" : "ok",
    consumerHealth: excessAccounts >= 2 ? "crit" : excessAccounts === 1 || blockedAccounts > 0 ? "warn" : "ok",
    policyHealth: resourcePolicy ? (excessAccounts > 0 ? "crit" : "warn") : "ok",
    serviceHealth: blockedAccounts > 0 ? "warn" : "ok",
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = item.value * (0.99 + 0.02 * Math.sin((index + (seed % 7)) / 2.5));
      return item.format === "percent" ? clamp(wave, 0, 100) : Math.max(0, wave);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const consumerLabel =
    v.excessAccounts > 0
      ? `${v.visibleAccounts} accounts visible · ${v.excessAccounts} over`
      : v.blockedAccounts > 0
        ? `${v.serviceAccounts} of ${INTENDED_ACCOUNTS} can reach`
        : `${INTENDED_ACCOUNTS} intended accounts`;

  return {
    t: 0,
    nodes: [
      {
        id: "owner",
        label: `owner ${OWNER_VPC}`,
        kind: "external",
        health: v.ownerHealth,
        sublabel: "VPC 10.20.0.0/16 · owner account",
        detail:
          "The owner account owns the VPC, subnets, route tables, network ACLs, and the shared service. Participants can create their own resources in the shared subnets but cannot modify the owner's network.",
        meta: { view: "flow" },
      },
      {
        id: "share",
        label: "RAM resource share",
        kind: "mesh",
        health: v.shareHealth,
        sublabel: v.shareScope ? `organization · ${ORG_ACCOUNTS} accounts` : `${v.accountsInShare} named accounts`,
        detail: v.shareScope
          ? "The share targets the organization. Every account in the organization can see the shared subnet, even if the service resource policy later narrows who can call the service."
          : "The share targets named accounts. Only those accounts can see the shared subnet; a new account needs an explicit change to the share.",
        meta: { view: "flow", visible: v.visibleAccounts },
      },
      {
        id: "consumers",
        label: "consumer accounts",
        kind: "client",
        health: v.consumerHealth,
        sublabel: consumerLabel,
        detail: v.excessAccounts
          ? `${v.excessAccounts} more accounts have access than the five intended. The excess may come from the share scope, the resource policy, or both.`
          : v.blockedAccounts
            ? `${v.blockedAccounts} intended accounts cannot reach the service even though the network may be shared.`
            : "The five intended accounts can use the shared subnet and reach the service through the owner's network.",
        meta: { view: "flow" },
      },
      {
        id: "policy",
        label: "service resource policy",
        kind: "mesh",
        health: v.policyHealth,
        sublabel: v.resourcePolicy ? "wildcard + org condition" : "five named principals",
        detail: v.resourcePolicy
          ? "The resource policy uses a wildcard principal with an organization condition. It does not grant access outside the organization, but it grants every account in the organization that can route to the service."
          : "The resource policy names the five intended account principals. An account that is not listed is denied even if it can see the shared subnet.",
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "shared service",
        kind: "service",
        health: v.serviceHealth,
        sublabel: `${v.serviceAccounts} accounts authorized`,
        detail: v.networkAllow
          ? "The service is reachable from the shared subnet range. Authorization is the intersection of the share, the resource policy, and the caller's identity policy."
          : "The owner network blocks the consumer range. Fixing the share or the resource policy does not create a network path.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("owner-share", "owner", "share", 1, "ok"),
      edge(
        "share-consumers",
        "share",
        "consumers",
        clamp(v.visibleAccounts / ORG_ACCOUNTS),
        v.excessAccounts > 0 ? "warn" : "ok",
      ),
      edge(
        "consumers-policy",
        "consumers",
        "policy",
        clamp(v.serviceAccounts / INTENDED_ACCOUNTS),
        v.excessAccounts > 0 ? "warn" : "ok",
      ),
      edge(
        "policy-service",
        "policy",
        "service",
        clamp(v.serviceAccounts / INTENDED_ACCOUNTS),
        v.blockedAccounts > 0 ? "crit" : "ok",
      ),
    ],
    metrics: [
      metric("service-reach", "Intended accounts reaching service", v.reach, "%", undefined, undefined, "percent"),
      metric("excess-accounts", "Accounts over the intended set", v.excessAccounts, "", 1, 2, "count"),
      metric("blocked-accounts", "Intended accounts blocked", v.blockedAccounts, "", 1, 2, "count"),
      metric("subnet-visibility", "Accounts that can see shared subnets", v.visibleAccounts, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      shareScope: v.shareScope ? 1 : 0,
      resourcePolicy: v.resourcePolicy ? 1 : 0,
      networkAllow: v.networkAllow ? 1 : 0,
      excess: v.excessAccounts,
    },
    summary: `${v.visibleAccounts} accounts see the subnets; ${v.serviceAccounts} can call the service; ${v.excessAccounts} over the intended five; ${v.blockedAccounts} intended accounts blocked.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "excess-accounts",
    metricId: "excess-accounts",
    warn: 1,
    crit: 2,
    title: "More accounts can reach the shared resources than intended",
    cause:
      "The RAM share targets the organization or more named accounts than the five intended, and the resource policy authorizes every account that can route. Trust expanded through configuration, not through a deliberate decision.",
    fix:
      "Narrow the share to the five named accounts or a dedicated OU, replace the wildcard principal with named principals or a tighter condition, and remove external principals. Verify the five intended accounts still work.",
    checkFirst: [
      "List the principals in the RAM resource share and the resource policy separately.",
      "Check whether the share is organization-wide or limited to named accounts.",
      "Compare the effective set with the intended five accounts, not with the account count in the share.",
    ],
  },
  {
    id: "blocked-accounts",
    metricId: "blocked-accounts",
    warn: 1,
    crit: 2,
    title: "Intended accounts cannot reach the shared service",
    cause:
      "The account is missing from the share, the resource policy does not name it, the owner network blocks the consumer range, or the caller's identity policy does not allow the action.",
    fix:
      "Work outward from the caller: confirm the shared subnet is visible, the resource policy allows the principal, the network path allows the range, and the caller's identity policy grants the action. Add only the missing layer.",
    checkFirst: [
      "Does the participant see the shared subnet in its own VPC console?",
      "Does the service resource policy name the participant account or principal?",
      "Does the owner's security group and subnet ACL allow the consumer range?",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const crossAccountModel: SimModel = {
  id: "cloud-networking-cross-account",
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
      shareScope: Number(frame.flags.shareScope ?? 0),
      resourcePolicy: Number(frame.flags.resourcePolicy ?? 0),
      networkAllow: Number(frame.flags.networkAllow ?? 1),
    };
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events].slice(-MAX_EVENTS);
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, values]) => [key, [...values]]),
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (previous.shareScope !== (v.shareScope ? 1 : 0)) {
      pushEvent(next, {
        id: "share-scope-change",
        at: frame.t,
        severity: v.shareScope ? "warn" : "info",
        title: v.shareScope ? "Subnet shared with the whole organization" : "Subnet share narrowed to named accounts",
        detail: v.shareScope
          ? `The RAM share now exposes ${OWNER_VPC} subnets to all ${ORG_ACCOUNTS} accounts in the organization. The resource policy still decides which accounts can call the service.`
          : `The RAM share now exposes the subnets only to ${v.accountsInShare} named accounts.`,
        nodeId: "share",
        metricId: "subnet-visibility",
      });
    }
    if (previous.resourcePolicy !== (v.resourcePolicy ? 1 : 0)) {
      pushEvent(next, {
        id: "resource-policy-change",
        at: frame.t,
        severity: v.resourcePolicy ? "crit" : "info",
        title: v.resourcePolicy ? "Resource policy widened to any organization account" : "Resource policy narrowed to named principals",
        detail: v.resourcePolicy
          ? "The wildcard principal with an organization condition permits every account in the organization that can reach the service. That is wider than five named principals and grows automatically when the organization grows."
          : "The resource policy now names the five intended account principals.",
        nodeId: "policy",
        metricId: "excess-accounts",
      });
    }
    if (previous.networkAllow !== (v.networkAllow ? 1 : 0)) {
      pushEvent(next, {
        id: "network-allow-change",
        at: frame.t,
        severity: v.networkAllow ? "info" : "crit",
        title: v.networkAllow ? "Owner network allows consumers" : "Owner network blocks consumers",
        detail: v.networkAllow
          ? "The subnet ACL and service security group allow the shared subnet range. Authorization still depends on the share and the resource policy."
          : "The owner network blocks the consumer range. Changing the share or the resource policy cannot fix a missing network path.",
        nodeId: "service",
        metricId: "blocked-accounts",
      });
    }
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (v.excessAccounts > 0) {
      items.push(
        `${v.visibleAccounts} accounts can see the shared subnets and ${v.serviceAccounts} can call the service. That is ${v.excessAccounts} more than the intended five.`,
      );
      items.push(
        v.shareScope && v.resourcePolicy
          ? "The organization share and the wildcard resource policy compound: the share makes every subnet visible, and the policy authorizes every account that can route. Narrow both layers."
          : v.shareScope
            ? "The organization share is the source of the excess visibility. The named resource policy limits service calls, but every organization account can still launch resources in the shared subnets."
            : "The named share limits subnet visibility, but the account count in the share is already above five. The resource policy cannot make the extra account disappear from the subnet.",
      );
    } else if (v.blockedAccounts > 0) {
      items.push(
        `${v.blockedAccounts} intended accounts cannot reach the service. ${v.networkAllow ? "The share and policy layers decide access; the network path is open." : "The owner network is blocking the consumer range, so no share or policy change will help."}`,
      );
    } else {
      items.push(
        `The five intended accounts can see the shared subnets and call the service. The share and the resource policy agree on the same principal set.`,
      );
    }
    items.push(
      "Cross-account access is an intersection: the resource share makes the subnet visible, the resource policy authorizes the service call, the network path allows the packet, and the caller's identity policy must allow the action.",
    );
    items.push(
      "A wildcard principal with an organization condition is not public access, but it names every current and future account in the organization as a permitted principal. The effective set still depends on the share and the network.",
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
    label: "Least privilege",
    description: "Five named accounts in the share, five named principals in the policy, and the network path open.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "One extra account",
    description: "Six named accounts share the subnet; the service policy still names five, so one has subnet access it does not need.",
    tone: "warn",
    params: defaults({ accountsInShare: 6 }),
  },
  {
    id: "failure",
    label: "Organization-wide",
    description: "The share targets the organization and the resource policy allows any account in it.",
    tone: "crit",
    params: defaults({ accountsInShare: 5, shareScope: 1, resourcePolicy: 1, networkAllow: 1 }),
  },
  {
    id: "blocked",
    label: "Three accounts shared",
    description: "Only three intended accounts are in the share, so two consumers are blocked.",
    tone: "crit",
    params: defaults({ accountsInShare: 3 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The share and policy are narrowed to the five intended named accounts.",
    tone: "ok",
    params: defaults({ accountsInShare: 5, shareScope: 0, resourcePolicy: 0, networkAllow: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-org-share",
  title: "Predict the effective account set",
  simId: "shared-vpc",
  question:
    "Five accounts are intended. The subnet is shared with the organization (12 accounts), and the service resource policy uses a wildcard principal with an organization condition. How many accounts can call the service?",
  prediction: {
    options: [
      { id: "five", label: "Five, because the resource policy names the five consumers." },
      { id: "twelve", label: "Twelve, because the share and the organization condition authorize every account in the organization." },
      { id: "zero", label: "Zero, because a wildcard principal is always denied." },
      { id: "one", label: "One, because the service has a single owner account." },
    ],
    correctOptionId: "twelve",
    explanation:
      "The share exposes the subnets to every account in the organization, and the wildcard principal with an organization condition authorizes every account that can reach the service. Five named principals are never mentioned. The effective set is the intersection of the share, the policy, and the network, which here is all 12 organization accounts.",
  },
  setup: defaults({ accountsInShare: 5, shareScope: 1, resourcePolicy: 1, networkAllow: 1 }),
  runFor: 15,
  observe: [
    "The share exposes the subnets to 12 accounts, not five.",
    "The service policy authorizes all 12 accounts that can route to it.",
    "Seven accounts are over the intended set.",
    "No intended account is blocked; the failure is excess trust, not availability.",
    "Narrowing the share alone is not enough if the resource policy remains wildcard.",
  ],
  explain:
    "Cross-account authorization is an intersection, but each layer can widen the set. The share controls subnet visibility. The resource policy controls who may call the service. A wildcard with an organization condition does not grant public access, but it grants every account in the organization, including accounts added later. The intended five were never encoded anywhere, so nothing limits the result to five.",
  fix: defaults({ accountsInShare: 5, shareScope: 0, resourcePolicy: 0, networkAllow: 1 }),
  debrief:
    "The design looked narrow because the policy had an organization condition, but an organization condition is a scope, not a five-account allow list. In production, write the intended principal set down, encode it in both the share and the resource policy, and alert when either set grows.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Cross-account networking connects resources that live in different AWS accounts without collapsing the accounts into one. The account boundary is a real trust boundary: identity policies, service control policies (SCPs), resource policies, and organization membership are evaluated in different places. A network path does not grant authorization, and authorization does not create a route.",
  },
  {
    type: "p",
    text: "There are several ways to connect accounts. VPC peering connects two VPCs. A transit gateway can be shared through AWS Resource Access Manager (RAM) so participants attach their VPCs to the owner's hub. VPC sharing through RAM lets participants launch resources into subnets the owner controls, but only within the same AWS Organizations organization. PrivateLink exposes a service without joining networks. This module uses a shared VPC because it makes the ownership split visible.",
  },
  {
    type: "p",
    text: "In a shared VPC, the owner account owns the VPC, subnets, route tables, network ACLs, and the shared service. Participant accounts can create and manage their own resources in the shared subnets, but they cannot view or modify the owner's resources or another participant's resources. The owner controls routing and subnet policy; the participant controls its own security groups and IAM.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "A participant request must pass four independent checks. The subnet must be visible through the RAM share. The service resource policy must allow the caller's principal. The owner network, including security groups and subnet ACLs, must allow the packet. The caller's identity policy must allow the API action. If any layer says no, the request fails, and each layer produces a different error.",
  },
  {
    type: "table",
    headers: ["Design", "Subnet visible to", "Service callable by", "Main risk"],
    rows: [
      ["Five named accounts + named principals", "Five", "Five", "Manual onboarding when the set changes."],
      ["Organization share + named principals", "All 12", "Five", "Extra accounts can launch in shared subnets."],
      ["Five named accounts + wildcard org policy", "Five", "Five", "Policy widens automatically if the share grows."],
      ["Organization share + wildcard org policy", "All 12", "All 12", "Trust expands with every new organization account."],
      ["Three named accounts + named principals", "Three", "Three", "Two intended consumers are blocked."],
    ],
  },
  {
    type: "p",
    text: "The table is the lesson. RAM sharing and resource policies are different controls. A share makes a resource discoverable and usable; a resource policy authorizes an action on a service. Using an organization as the principal is convenient and keeps the grant inside the organization, but it is still broader than five named accounts. A new account added to the organization inherits the access without a new decision.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Named accounts in the share versus the organization-wide share, and the subnet visibility each produces.",
      "The service resource policy: five named principals or a wildcard with an organization condition.",
      "Accounts over the intended set and intended accounts that are blocked.",
      "The owner network allow, which is a separate gate from the share and the policy.",
      "Node health on the share, the policy, and the service so the layer that widens or blocks access is visible.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with least privilege and confirm that all five intended accounts reach the service. Switch the share to the organization: subnet visibility grows but service calls stay at five. Then widen the resource policy: service access jumps to all 12. Finally, reduce the named accounts and turn off the owner network allow to see the two different blocked paths.",
  },
  {
    type: "p",
    text: "The organization has 12 accounts and the service has five intended consumers in this scenario. Those counts are illustrative teaching values, not AWS limits. The ownership split, share behavior, and policy intersection follow AWS documentation.",
  },
  { type: "sim", simId: "shared-vpc" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The organization share made the subnets visible to 12 accounts. The wildcard resource policy then authorized every account that could route to the service. The result was 12 consumers, seven more than intended, even though nobody explicitly added seven principals. The share and the policy each widened the set.",
  },
  {
    type: "p",
    text: "The blocked variant failed for the opposite reason. Only three named accounts were in the share, so two intended consumers could not see the subnet. The service was healthy, the owner network was open, and the policy named five principals. Visibility was the missing layer.",
  },
  {
    type: "p",
    text: "Turning off the owner network allow produced a third signal. The share and policy could both be correct and the packet still could not reach the service. Authorization is not connectivity, and connectivity is not authorization.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "The RAM console lists the resource share, its principals, and the resources. The participant sees the shared subnet in its own VPC console, with the owner account ID.",
      "The service resource policy shows the principal set. A wildcard with an aws:PrincipalOrgID condition is scoped to the organization, but it is not a five-account allow list.",
      "CloudTrail records share creation and principal changes. IAM Access Analyzer can flag external access and unused permissions; use it as evidence, not as the only control.",
      "A participant that can see the subnet but gets AccessDenied is failing authorization. A participant that cannot see the subnet is failing the share. A timeout usually points at the network.",
      "SCPs apply to principals in the participant account and can deny an action even when the resource policy allows it. Check the organization policy layer before changing the share.",
      "The owner pays for the network components it owns, while participants pay for their own resources. Cost ownership follows resource ownership, not the network path.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Write down the intended account set. Compare it with the share principals, then with the resource policy principals, then with the network allow. Do not fix a timeout by widening the resource policy, and do not fix AccessDenied by changing routes. Each layer has its own evidence.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "List the intended accounts and the service they need. Keep the list in code or a reviewed configuration, not in a wiki.",
      "Narrow the RAM share to those accounts or a dedicated organizational unit. Remove organization-wide sharing if it is not required.",
      "Replace the wildcard resource policy with named principals, or keep the organization condition but add a tighter account or OU condition.",
      "Verify the owner security group and subnet ACL allow the consumer range, and that the participant route table can reach the service.",
      "Confirm each participant's identity policy allows the action; a resource policy alone does not grant an IAM principal permission.",
      "Remove external principals and test that an unintended account is denied, not only that the intended accounts work.",
      "Alert on share principal changes and resource policy changes so the trust set cannot grow silently.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "An organization share simplifies onboarding and keeps grants inside the organization, but it gives every current and future account the same subnet visibility. Named accounts are narrower but require a change for every new consumer.",
      "A shared VPC gives participants implicit routing and central network ownership, but it couples their resources to the owner's route tables, ACLs, and maintenance. Separate VPCs with peering or a transit gateway cost more to operate but preserve cleaner boundaries.",
      "A wildcard resource policy with an organization condition is easy to audit at the organization level, but it cannot express the five-account intent. Named principals are more precise and more work to maintain.",
      "Centralized ownership makes the network consistent and puts the blast radius in one account. Federated ownership moves control closer to the teams but multiplies the number of trust relationships.",
      "Access Analyzer and CloudTrail improve visibility, but they detect drift after it happens. The durable control is a reviewed, codified principal set.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "design-five-accounts",
    question:
      "A shared service in one account must be reachable from five workload accounts. How do you connect them with the least privilege, and what do you verify?",
    difficulty: 3,
    hints: [
      "Separate network visibility from service authorization.",
      "Write the intended principal set down first.",
    ],
    answer:
      "I would choose shared subnets through RAM if the accounts are in the same organization and need implicit routing, or a transit gateway if they need broader connectivity. I would share the subnets with the five named accounts or a dedicated OU, not the whole organization, and I would put the service behind a resource policy that names the five principals or uses a tight account condition. The owner keeps the route tables, ACLs, and service; participants keep their own resources and security groups. I would verify four layers: the participant sees the shared subnet, the resource policy allows the principal, the owner security group and ACL allow the range, and the participant identity policy allows the action. I would also test that a sixth account is denied and alert on principal changes.",
    followUps: [
      "When would you use a transit gateway instead of shared subnets?",
      "What does the participant still control?",
      "How would you onboard the sixth account safely?",
    ],
    redFlags: [
      "Shares with the whole organization for convenience.",
      "Uses a wildcard resource policy without a condition.",
      "Checks only the network path.",
    ],
    rubric: [
      "Separates share, policy, network, and identity.",
      "Chooses named accounts or a narrow OU.",
      "States owner and participant responsibilities.",
      "Tests a denial, not only the happy path.",
    ],
  },
  {
    id: "wildcard-org-policy",
    question:
      "Is a resource policy with Principal \"*\" and an aws:PrincipalOrgID condition safe for a service that only five accounts should use?",
    difficulty: 3,
    hints: [
      "The condition limits the scope, not the count.",
      "A new account inherits organization membership.",
    ],
    answer:
      "It is scoped to the organization, so it is not public access, but it is broader than five accounts. Every account in the organization that can reach the service is authorized, and a new account added to the organization inherits that access without a new review. If the five-account set is the requirement, I would name the principals or use a tighter condition on account IDs or a dedicated OU. I would keep the organization condition only as an additional guardrail, not as the primary limit, and I would monitor the principal set and test that a non-intended account is denied.",
    followUps: [
      "What condition keys would you use?",
      "How does an SCP change the answer?",
      "Would you use this for a public-facing service?",
    ],
    redFlags: [
      "Calls the policy public access.",
      "Says the organization condition enforces five accounts.",
      "Ignores future accounts.",
    ],
    rubric: [
      "Explains the organization scope.",
      "States that the count is not limited to five.",
      "Proposes named principals or a tighter condition.",
      "Mentions monitoring and denial testing.",
    ],
  },
  {
    id: "participant-cannot-launch",
    question:
      "A participant account accepted the subnet share but still cannot launch an instance into the shared subnet. What do you check?",
    difficulty: 2,
    hints: [
      "The share is only one layer.",
      "The participant needs its own permissions and a usable subnet.",
    ],
    answer:
      "I would confirm the participant sees the shared subnet and that the share is accepted. Then I would check the participant's IAM policy for the launch action and any SCP that denies it. I would check the subnet has available IP addresses and that the participant's security group and key pair are in the same account and Region. I would also check that the owner has not removed the share or changed the subnet. The owner's network ACL does not block the launch API itself; it affects traffic after the instance exists. If the instance launches but cannot reach the service, then I would move to the route, security group, and resource policy layers.",
    followUps: [
      "Which of these checks is the participant's responsibility?",
      "What would a subnet with no free IPs look like?",
      "How would you prove the share is accepted?",
    ],
    redFlags: [
      "Changes the owner route table first.",
      "Assumes the share grants IAM permission.",
      "Ignores IP exhaustion.",
    ],
    rubric: [
      "Checks share acceptance and visibility.",
      "Separates IAM/SCP from network.",
      "Checks subnet capacity.",
      "Distinguishes launch failure from traffic failure.",
    ],
  },
];

const checklist = [
  {
    title: "Before the design",
    items: [
      "The intended account set and the service each account needs are written down.",
      "The accounts are in the same organization if shared subnets are required.",
      "The owner of the VPC, route tables, ACLs, and service is named.",
      "The participant responsibilities for security groups, IAM, and resources are agreed.",
      "An alternative such as peering, a transit gateway, or PrivateLink is considered.",
    ],
  },
  {
    title: "Before the change",
    items: [
      "The RAM share lists named accounts or a dedicated OU, not the whole organization.",
      "The resource policy names principals or uses a tight account condition.",
      "The owner security group and subnet ACL allow the participant range.",
      "The participant identity policy allows the action and no SCP denies it.",
      "A denial test is planned for an account outside the intended set.",
    ],
  },
  {
    title: "After the change",
    items: [
      "Every intended account reaches the service and an unintended account is denied.",
      "The share and policy principal sets match the reviewed intent.",
      "CloudTrail and Access Analyzer show no unexplained external access.",
      "The onboarding path for a sixth account requires an explicit review.",
    ],
  },
];

const references = [
  {
    title: "Share your VPC subnets with other accounts",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/vpc-sharing.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Owner and participant responsibilities, organization requirement, and shared subnet behavior.",
  },
  {
    title: "What is AWS Resource Access Manager?",
    url: "https://docs.aws.amazon.com/ram/latest/userguide/what-is.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Resource shares, organization and OU principals, invitations, and ownership.",
  },
  {
    title: "Terms and concepts for AWS RAM",
    url: "https://docs.aws.amazon.com/ram/latest/userguide/getting-started-terms-and-concepts.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Managed permissions, resource-based policies, and the consuming principal's IAM layer.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "shared-vpc": {
      model: crossAccountModel,
      presets,
      instructions:
        "Start with five named accounts. Widen the share to the organization, then the resource policy, then narrow the share and remove the network allow to compare excess trust with blocked access.",
      experimentIds: [experiment.id],
      note: "Illustrative shared VPC with 12 organization accounts and five intended consumers. Counts are teaching values, not AWS limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-peering-vs-tgw",
    "cloud-networking-ram",
    "cloud-networking-nacls",
    "cloud-networking-security-groups",
  ],
};
