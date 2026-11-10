import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimEdge, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const NAME = "orders.internal";
const SOURCE_LABELS = ["the internet", "VPC A (associated)", "VPC B (not associated)"];

const params = [
  {
    id: "querySource",
    label: "Query source (0 internet, 1 associated VPC, 2 unassociated VPC)",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Query",
    help: "0 resolves through public DNS. 1 is a VPC associated with the private hosted zone. 2 is a VPC that is not associated, so it cannot see the private zone.",
    format: "count" as const,
  },
  {
    id: "privateZone",
    label: "Private hosted zone exists",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Zone",
    help: "1 creates a private hosted zone for orders.internal and associates it with VPC A. 0 leaves only the public zone, if one exists.",
    format: "count" as const,
  },
  {
    id: "publicZone",
    label: "Public hosted zone exists",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Zone",
    help: "1 creates a public hosted zone for orders.internal. A public zone answers internet queries and is visible to every VPC that is not using a matching private zone.",
    format: "count" as const,
  },
  {
    id: "recordPlacement",
    label: "Record placement (0 private only, 1 public only, 2 both)",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Record",
    help: "Where the orders.internal record exists. Both zones with the same name is split-horizon DNS; the public copy is visible on the internet.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type AnswerSource = "private" | "public" | "none";

interface Computed {
  querySource: number;
  privateZone: boolean;
  publicZone: boolean;
  placement: number;
  privateRecord: boolean;
  publicRecord: boolean;
  answerSource: AnswerSource;
  resolution: number;
  failureRate: number;
  exposure: number;
  privateAnswer: number;
  publicAnswer: number;
  clientHealth: Health;
  resolverHealth: Health;
  privateZoneHealth: Health;
  publicZoneHealth: Health;
  recordHealth: Health;
}

function compute(p: Params): Computed {
  const querySource = Math.max(0, Math.min(2, Math.round(num(p, "querySource", 1))));
  const privateZone = num(p, "privateZone", 1) >= 0.5;
  const publicZone = num(p, "publicZone", 1) >= 0.5;
  const placement = Math.max(0, Math.min(2, Math.round(num(p, "recordPlacement", 0))));
  const privateRecord = privateZone && (placement === 0 || placement === 2);
  const publicRecord = publicZone && (placement === 1 || placement === 2);
  let answerSource: AnswerSource;
  if (querySource === 0) {
    answerSource = publicRecord ? "public" : "none";
  } else if (querySource === 1 && privateZone) {
    answerSource = privateRecord ? "private" : "none";
  } else {
    answerSource = publicRecord ? "public" : "none";
  }
  const resolution = answerSource === "none" ? 0 : 100;
  return {
    querySource,
    privateZone,
    publicZone,
    placement,
    privateRecord,
    publicRecord,
    answerSource,
    resolution,
    failureRate: clamp(100 - resolution, 0, 100),
    exposure: publicRecord ? 100 : 0,
    privateAnswer: answerSource === "private" ? 100 : 0,
    publicAnswer: answerSource === "public" ? 100 : 0,
    clientHealth: resolution === 100 ? "ok" : "crit",
    resolverHealth: querySource === 2 && privateZone ? "warn" : "ok",
    privateZoneHealth: privateRecord ? "ok" : "crit",
    publicZoneHealth: publicRecord ? "ok" : "crit",
    recordHealth: answerSource === "none" ? "down" : publicRecord ? "crit" : "ok",
  };
}

function formatPercent(value: number): string {
  return value >= 99.95 ? "100" : value.toFixed(1);
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 24;
  const jitter = (offset: number) => 0.99 + 0.02 * Math.sin((offset + (seed % 4)) / 2.6);
  const rows: [string, number][] = [
    ["resolution", values.resolution],
    ["resolution-failure", values.failureRate],
    ["public-exposure", values.exposure],
    ["answers-private", values.privateAnswer],
    ["answers-public", values.publicAnswer],
  ];
  for (const [id, value] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) => clamp(value * jitter(index), 0, 100));
  }
  frame.flags.seriesSeeded = 1;
}

function answerLabel(values: Computed): string {
  if (values.answerSource === "private") return "private zone answer";
  if (values.answerSource === "public") return "public zone answer";
  if (values.querySource === 1 && values.privateZone) return "NXDOMAIN from the private zone";
  return "NXDOMAIN";
}

function zoneInPath(values: Computed): "private" | "public" | "none" {
  if (values.answerSource === "private") return "private";
  if (values.answerSource === "public") return "public";
  if (values.querySource === 1 && values.privateZone) return "private";
  if (values.publicZone) return "public";
  return "none";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const zone = zoneInPath(v);
  const nodes: SimNode[] = [
    {
      id: "client",
      label:
        v.querySource === 0
          ? "internet client"
          : v.querySource === 1
            ? "VPC A workload"
            : "VPC B workload",
      kind: v.querySource === 0 ? ("client" as const) : ("service" as const),
      health: v.clientHealth,
      sublabel: `query ${NAME}`,
      detail:
        v.querySource === 0
          ? "The client asks public DNS for the internal name. It has no route into VPC A and does not use the VPC Resolver."
          : v.querySource === 1
            ? "The workload runs in VPC A, which is associated with the private hosted zone. Its DNS query goes to the VPC Resolver at the VPC CIDR plus two address."
            : "The workload runs in VPC B, which is not associated with the private hosted zone. The VPC Resolver cannot use the private zone for this name.",
      meta: { view: "flow" },
    },
  ];
  const edges: SimEdge[] = [];
  if (v.querySource > 0) {
    nodes.push({
      id: "resolver",
      label: "Route 53 Resolver",
      kind: "dns",
      health: v.resolverHealth,
      sublabel: v.querySource === 2 ? "private zone not visible" : "VPC resolution",
      detail:
        v.querySource === 1
          ? "The Resolver checks the private hosted zones associated with VPC A. A matching private zone takes precedence over public DNS for that name."
          : "VPC B is not associated with the private zone, so the Resolver does not see it. It resolves the name through public DNS if a public record exists.",
      meta: { view: "flow" },
    });
    edges.push(edge("client-resolver", "client", "resolver", 1, v.clientHealth));
  }
  if (zone === "private") {
    nodes.push({
      id: "private-zone",
      label: "private hosted zone",
      kind: "dns",
      health: v.privateZoneHealth,
      sublabel: v.privateRecord ? "record present" : "record missing",
      detail: v.privateRecord
        ? "The private zone contains the orders.internal record and is associated with VPC A. This answer is not visible on the internet."
        : "The private zone matches the name but has no record for it. The Resolver returns NXDOMAIN; it does not fall back to a public record with the same name.",
      meta: { view: "flow" },
    });
    edges.push(
      edge(
        v.querySource > 0 ? "resolver-private" : "client-private",
        v.querySource > 0 ? "resolver" : "client",
        "private-zone",
        1,
        v.privateZoneHealth,
      ),
    );
  } else if (zone === "public") {
    nodes.push({
      id: "public-zone",
      label: "public hosted zone",
      kind: "dns",
      health: v.publicZoneHealth,
      sublabel: v.publicRecord ? "record present" : "record missing",
      detail: v.publicRecord
        ? "The public zone contains the same name and answers internet queries. It is also the fallback for a VPC that is not associated with a matching private zone."
        : "The public zone exists but has no record for this name. Public DNS returns NXDOMAIN.",
      meta: { view: "flow" },
    });
    edges.push(
      edge(
        v.querySource > 0 ? "resolver-public" : "client-public",
        v.querySource > 0 ? "resolver" : "client",
        "public-zone",
        1,
        v.publicZoneHealth,
      ),
    );
  }
  nodes.push({
    id: "record",
    label: NAME,
    kind: "service",
    health: v.recordHealth,
    sublabel:
      v.answerSource === "private"
        ? "private answer"
        : v.answerSource === "public"
          ? "public answer"
          : "NXDOMAIN",
    detail:
      v.answerSource === "private"
        ? "The answer came from the private hosted zone. If the same name also exists in the public zone, the private answer is used only inside associated VPCs; the public copy remains visible outside."
        : v.answerSource === "public"
          ? "The answer came from the public hosted zone. Anyone on the internet can resolve it, which is why an internal-only name should not be published there."
          : "No record answered the query. The result is NXDOMAIN; a private zone match without a record does not fall back to public DNS.",
    meta: { view: "flow" },
  });
  if (zone !== "none") {
    edges.push(edge(`${zone}-record`, `${zone}-zone`, "record", v.resolution / 100, v.recordHealth));
  } else if (v.querySource > 0) {
    edges.push(edge("resolver-record", "resolver", "record", 0.4, v.clientHealth));
  } else {
    edges.push(edge("client-record", "client", "record", 0.4, v.clientHealth));
  }
  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("resolution", "Name resolution", v.resolution, "%", undefined, undefined, "percent"),
      metric("resolution-failure", "Name resolution failures", v.failureRate, "%", 0.5, 5, "percent"),
      metric("public-exposure", "Public exposure of the internal name", v.exposure, "%", 0.1, 1, "percent"),
      metric("answers-private", "Answers from private zone", v.privateAnswer, "%", undefined, undefined, "percent"),
      metric("answers-public", "Answers from public zone", v.publicAnswer, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      querySource: v.querySource,
      privateZone: v.privateZone ? 1 : 0,
      publicZone: v.publicZone ? 1 : 0,
      recordPlacement: v.placement,
    },
    summary: `Query from ${SOURCE_LABELS[v.querySource]}; ${answerLabel(v)}; ${formatPercent(
      v.exposure,
    )}% public exposure of ${NAME}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "public-exposure",
    metricId: "public-exposure",
    warn: 0.1,
    crit: 1,
    title: "The internal name is visible in public DNS",
    cause:
      "A record for the internal name exists in a public hosted zone. A private hosted zone does not hide a public record; it only changes the answer inside associated VPCs.",
    fix:
      "Remove the internal record from the public zone, or publish a different public name. If split-horizon DNS is intentional, keep the public record limited to public content and document the exception.",
    checkFirst: [
      "Search every public hosted zone for the exact name, not only the zone apex.",
      "Check whether the private zone has the same name and which VPCs are associated.",
      "Resolve the name from outside the VPC to confirm what the internet sees.",
    ],
  },
  {
    id: "resolution-failure",
    metricId: "resolution-failure",
    warn: 99.5,
    crit: 95,
    title: "The name does not resolve from this source",
    cause:
      "The queried source is not associated with the private zone, the private zone has no matching record, or there is no public record for an internet query. A private zone match without a record returns NXDOMAIN instead of falling back to public DNS.",
    fix:
      "Create the record in the zone that serves the source, or associate the VPC with the private zone. For an internet client, publish a public record only if the name is meant to be public.",
    checkFirst: [
      "Check the query source's VPC association with the private hosted zone.",
      "Check the record name and type in the zone that should answer.",
      "Check whether a matching private zone exists without the record, which prevents public fallback.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const privateHostedZonesModel: SimModel = {
  id: "cloud-networking-private-hosted-zones",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const v = compute(p);
    const previousSource = Number(frame.flags.querySource ?? -1);
    const previousPlacement = Number(frame.flags.recordPlacement ?? -1);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = [...frame.events].slice(-60);
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (previousSource !== -1 && previousSource !== v.querySource) {
      pushEvent(next, {
        id: "private-zone-source-change",
        severity: v.resolution === 100 ? "info" : "warn",
        title:
          v.resolution === 100
            ? `Query from ${SOURCE_LABELS[v.querySource]} resolves`
            : `Query from ${SOURCE_LABELS[v.querySource]} does not resolve`,
        detail:
          v.answerSource === "private"
            ? "The source is inside the private zone's scope, so the private record answers."
            : v.answerSource === "public"
              ? "The source is outside the private zone's scope, so public DNS answers. Check whether the name is meant to be public."
              : "The source is outside the private zone's scope, or the zone has no matching record. Check the association and the record placement.",
        nodeId: "record",
        metricId: v.resolution === 100 ? "resolution" : "public-exposure",
      });
    }
    if (previousPlacement !== -1 && previousPlacement !== v.placement) {
      pushEvent(next, {
        id: "private-zone-placement-change",
        severity: v.exposure > 0 ? "crit" : "info",
        title:
          v.exposure > 0
            ? "The internal name now exists in the public zone"
            : "The internal name is private only",
        detail:
          v.exposure > 0
            ? "A public hosted zone record makes the name resolvable on the internet. A private hosted zone changes the answer inside associated VPCs; it does not hide the public record."
            : "The public zone no longer contains the internal name. Associated VPCs still resolve it from the private zone.",
        nodeId: "record",
        metricId: "public-exposure",
      });
    }
    next.summary = `Query from ${SOURCE_LABELS[v.querySource]}; ${answerLabel(v)}; ${formatPercent(
      v.exposure,
    )}% public exposure of ${NAME}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (v.exposure > 0) {
      items.push(
        `${NAME} exists in a public hosted zone, so anyone on the internet can resolve it. The private zone does not hide the public record; it only changes the answer for associated VPCs.`,
      );
    }
    if (v.answerSource === "private") {
      items.push(
        "The answer came from the private zone because the source VPC is associated with it. The public copy, if present, is still visible outside the association.",
      );
    } else if (v.answerSource === "public") {
      items.push(
        "The answer came from public DNS. That is expected for an internet client, but it is a leak for an internal name that should only resolve inside associated VPCs.",
      );
    } else if (v.querySource === 1 && v.privateZone) {
      items.push(
        "VPC A is associated with the private zone, and the zone matches the name, but the record is missing. The Resolver returns NXDOMAIN and does not fall back to a public record with the same name.",
      );
    } else {
      items.push(
        "The source has no zone that can answer. An unassociated VPC does not see the private zone, and without a public record there is nothing else to resolve.",
      );
    }
    items.push(
      "A private hosted zone resolves only in associated VPCs and through an inbound Resolver endpoint from a hybrid network. A public hosted zone resolves globally.",
    );
    items.push(
      "Split-view DNS uses the same name in both zones: associated VPCs get the private answer, while the internet gets the public answer.",
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
    description: "VPC A is associated with the private zone and resolves a private-only record.",
    tone: "ok",
    params: defaults({ querySource: 1, privateZone: 1, publicZone: 1, recordPlacement: 0 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "VPC A gets the private answer, but the same name also exists in the public zone.",
    tone: "crit",
    params: defaults({ querySource: 1, privateZone: 1, publicZone: 1, recordPlacement: 2 }),
  },
  {
    id: "failure",
    label: "Public exposure",
    description: "An internet client resolves the internal name from the public zone.",
    tone: "crit",
    params: defaults({ querySource: 0, privateZone: 1, publicZone: 1, recordPlacement: 2 }),
  },
  {
    id: "unassociated",
    label: "Unassociated VPC",
    description: "VPC B is not associated with the private zone and there is no public record, so the name does not resolve.",
    tone: "crit",
    params: defaults({ querySource: 2, privateZone: 1, publicZone: 0, recordPlacement: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The internal name is private only, and VPC A resolves it from the associated zone.",
    tone: "ok",
    params: defaults({ querySource: 1, privateZone: 1, publicZone: 1, recordPlacement: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-public-internal-name",
  title: "The name that was visible outside the VPC",
  simId: "private-zone-resolution",
  question:
    "An internal service name resolves from the internet. The private hosted zone exists and VPC A is associated with it. What is the most likely cause?",
  prediction: {
    options: [
      { id: "association", label: "VPC A is not associated with the private zone." },
      { id: "public-record", label: "The same name also exists in a public hosted zone." },
      { id: "resolver-rule", label: "The VPC Resolver is forwarding the zone to on-premises." },
      { id: "dnssec", label: "DNSSEC is disabled on the private zone." },
    ],
    correctOptionId: "public-record",
    explanation:
      "A private hosted zone changes the answer only inside associated VPCs. If the name also exists in a public hosted zone, internet clients resolve the public record normally. The private zone is not a firewall around the name; it is a separate zone with its own records.",
  },
  setup: defaults({ querySource: 0, privateZone: 1, publicZone: 1, recordPlacement: 2 }),
  runFor: 15,
  observe: [
    "The internet client resolves the name from the public zone.",
    "Public exposure is 100%, even though the private zone is associated and healthy.",
    "Switching the query source to VPC A returns the private answer, but the public record still exists.",
    "Removing the record from the public zone clears the exposure.",
    "A private zone does not hide a public record with the same name.",
  ],
  explain:
    "Publishing the name in a public hosted zone makes it globally resolvable. Associating the private zone with VPC A only changes resolution inside VPC A, where the private zone takes precedence. If the name should be internal only, the record must be absent from the public zone, or the public zone must use a different name. Split-horizon DNS is the deliberate case where both records exist and serve different audiences.",
  fix: defaults({ querySource: 0, privateZone: 1, publicZone: 1, recordPlacement: 0 }),
  debrief:
    "After removing the public record, the internet query returns NXDOMAIN and the associated VPC still resolves the private record. The private zone was never the problem; the public copy was. In production, search every public zone for the internal name before assuming an association change will fix it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Route 53 private hosted zone is a container for Domain Name System (DNS) records that answer only inside the virtual private clouds (VPCs) associated with it. You create the zone, associate one or more VPCs, and create records for names such as orders.internal. A workload in an associated VPC sends the query to the Route 53 Resolver at the VPC CIDR plus two address, and the Resolver answers from the private zone. The records are not returned to the public internet.",
  },
  {
    type: "p",
    text: "A public hosted zone is the opposite: it answers queries from anywhere. If the same name exists in both a public and a private zone, that is split-view DNS, also called split-horizon DNS. An associated VPC gets the private answer because the Resolver matches the private zone first. An internet client gets the public answer. An unassociated VPC does not see the private zone, so it also gets the public answer if one exists.",
  },
  {
    type: "p",
    text: "Association is the whole boundary. A private hosted zone that is associated with VPC A does not answer for VPC B, even when both VPCs are in the same account and Region. The VPC also needs DNS support and DNS hostnames enabled. For on-premises or another VPC, an inbound Resolver endpoint provides the private path into the associated VPC.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, DNS resolver, hosted zone, record. For an internet client, the resolver is public DNS and the zone is the public hosted zone. For a VPC workload, the resolver is the VPC Resolver and the zone is a private hosted zone if the VPC is associated with it. The same name can take different paths depending on the source, which is why testing from one location is not enough.",
  },
  {
    type: "table",
    headers: ["Query source", "Private zone visible", "Public zone visible", "Result"],
    rows: [
      ["Internet", "No", "Yes", "Public record, if one exists; otherwise NXDOMAIN."],
      ["Associated VPC", "Yes", "Only if no private match", "Private record. A private match without a record returns NXDOMAIN."],
      ["Unassociated VPC", "No", "Yes", "Public record, if one exists; otherwise NXDOMAIN."],
    ],
  },
  {
    type: "compare",
    leftTitle: "Private hosted zone",
    rightTitle: "Public hosted zone",
    rows: [
      { label: "Who can resolve", left: "Associated VPCs and inbound Resolver paths.", right: "Anyone on the internet." },
      { label: "Record visibility", left: "Private to the association.", right: "Global." },
      { label: "Association", left: "Required per VPC.", right: "Not applicable." },
      { label: "Same name in both", left: "Private answer wins inside associated VPCs.", right: "Public answer serves everyone else." },
    ],
  },
  {
    type: "p",
    text: "The subtle case is a private zone that matches the name but has no record. The Resolver returns NXDOMAIN; it does not fall back to a public record with the same name. That is useful for keeping a name private, and confusing when someone expects the public record to be a fallback. Check the record in the zone that is supposed to answer, not only the association.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A query-source selector for the internet, an associated VPC, and an unassociated VPC.",
      "Private and public zone toggles plus a record-placement selector for private only, public only, or both.",
      "Name resolution and public exposure as separate metrics, because a private answer can coexist with a public leak.",
      "A path that changes between the private zone and the public zone as the source changes.",
      "Presets for a healthy private record, split-horizon exposure, an internet leak, an unassociated VPC, and recovery.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy: VPC A is associated and the record is private only. Switch the source to the internet and watch the query fail. Then set the record placement to both and switch back: the internet now resolves the internal name. Finally query from VPC B without a public record and compare NXDOMAIN with the associated VPC. Run the experiment before revealing its explanation.",
  },
  {
    type: "p",
    text: "The name and query outcomes are illustrative, but the zone behavior is the documented Route 53 behavior: private zones resolve only in associated VPCs and through inbound Resolver paths, public zones resolve globally, and a private match without a record returns NXDOMAIN rather than falling back to public DNS.",
  },
  { type: "sim", simId: "private-zone-resolution" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Inside VPC A, the Resolver matched the private hosted zone and returned the private record. The public zone did not answer for that source because the private zone took precedence. That is the intended behavior of a private zone: it changes resolution for the associated VPCs, not for the world.",
  },
  {
    type: "p",
    text: "When the record also existed in the public zone, an internet query resolved the same name. The private zone was still healthy and still associated, but it could not hide the public record. Public exposure was 100% while the private answer remained correct for VPC A.",
  },
  {
    type: "p",
    text: "An unassociated VPC behaved like the internet: it could not see the private zone and resolved the public record if one existed, or returned NXDOMAIN if not. The association, not the account boundary, decided which zone was visible.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Private hosted zone associations: each zone lists the VPCs that can use it. A VPC in the same account is not automatically associated.",
      "Public hosted zones: a record with the internal name is globally resolvable. Deleting the private zone does not remove it.",
      "Resolver query logs: the source VPC and the response code show whether the private zone or public DNS answered.",
      "NXDOMAIN: a matching private zone without the record returns NXDOMAIN, not the public answer. That can look like a missing association when the record is the real gap.",
      "Split-view DNS: the same name in both zones is valid when the public and private answers are intentionally different. Document which audience gets which answer.",
      "VPC settings: private hosted zones require DNS support and DNS hostnames on the VPC.",
      "Hybrid access: an on-premises client needs an inbound Resolver endpoint into an associated VPC; it cannot query the VPC Resolver address directly.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Resolve the name from outside the VPC before changing anything. If it answers publicly, find the record in the public zone. Then check the private zone's VPC associations. Do not assume that associating another VPC, or deleting the private zone, will remove a public record.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Resolve the name from the internet and from the affected VPC. Record the answer and the source.",
      "Search every public hosted zone for the exact name, including subdomains and wildcard records.",
      "If the name is internal only, remove the public record and keep the private record.",
      "If split-horizon DNS is intentional, keep both records but make the public answer safe for public consumption.",
      "Associate the private zone with every VPC that must resolve it, and enable DNS support and hostnames.",
      "For on-premises clients, create an inbound Resolver endpoint in an associated VPC and forward the zone to it.",
      "Re-test from each source and confirm the public query no longer returns the internal address.",
      "Add a check that alerts on new public records for internal-only names.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A private hosted zone keeps internal names out of public DNS, but every VPC that needs the name must be associated, and hybrid clients need an inbound endpoint.",
      "Split-view DNS lets the same name serve internal and public audiences, but it doubles the record management and makes a leak easy to miss.",
      "A public record for an internal name can simplify vendor or certificate validation, but it exposes the name and often the address. Prefer a separate public name.",
      "Associating many VPCs with one private zone centralizes records, but it broadens the blast radius of a bad change and can cross account boundaries only with authorization.",
      "Deleting a private zone is not a privacy control if a public record exists. Remove the public record first.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "public-internal-name",
    question:
      "An internal service name resolves from the internet. The private hosted zone is associated with the right VPC. What do you check, and what is the likely cause?",
    difficulty: 2,
    hints: [
      "A private zone does not hide a public record.",
      "Search all public zones, not just the obvious one.",
    ],
    answer:
      "I would resolve the name from outside the VPC and trace which zone answered. If it resolves publicly, a record for the same name exists in a public hosted zone, possibly a parent zone or a wildcard. The private zone only changes resolution inside associated VPCs; it is not a firewall around the name. I would search every public zone for the exact name and remove the record if the name is internal only, or switch to a distinct public name. I would also check that no wildcard record covers it and add a guardrail against publishing internal names.",
    followUps: [
      "What would split-view DNS look like here?",
      "Could a wildcard record cause this?",
      "How would you prove which zone answered?",
    ],
    redFlags: [
      "Deletes and recreates the private zone.",
      "Adds another VPC association.",
      "Assumes the private zone overrides public DNS globally.",
    ],
    rubric: [
      "Separates private scope from public scope.",
      "Searches public zones for the record.",
      "Removes or renames the public record.",
      "Considers wildcards and query logs.",
    ],
  },
  {
    id: "unassociated-vpc",
    question:
      "VPC B cannot resolve a name that VPC A resolves from the same private hosted zone. Both VPCs are in the same account. What is the difference?",
    difficulty: 2,
    hints: [
      "Association is per VPC.",
      "The account boundary is not the zone boundary.",
    ],
    answer:
      "VPC A is associated with the private hosted zone and VPC B is not. A private hosted zone answers only for the VPCs explicitly associated with it, regardless of whether they are in the same account. I would associate VPC B with the zone, then confirm DNS support and DNS hostnames are enabled in VPC B. If VPC B is in another account, the association needs authorization. If the name should be shared more broadly, a centralized inbound endpoint or a shared zone design may be better than associating every VPC.",
    followUps: [
      "How would you share a private zone across accounts?",
      "What VPC DNS settings are required?",
      "When would an inbound Resolver endpoint be better than an association?",
    ],
    redFlags: [
      "Assumes same-account VPCs share private zones.",
      "Changes the record instead of the association.",
      "Ignores DNS support and hostnames.",
    ],
    rubric: [
      "Names the missing association.",
      "Knows association is per VPC.",
      "Checks DNS support and hostnames.",
      "Considers cross-account authorization.",
    ],
  },
  {
    id: "nxdomain-vs-fallback",
    question:
      "A private zone matches the name but the record is missing. A public record with the same name exists. What does an associated VPC get, and why?",
    difficulty: 3,
    hints: [
      "The private zone match is evaluated first.",
      "The Resolver does not merge the two zones.",
    ],
    answer:
      "The associated VPC gets NXDOMAIN. The Resolver matches the private hosted zone for the name and looks for the record there; when the record is absent, it does not fall back to the public zone. That behavior keeps a private name from leaking a public answer, but it also means a missing record looks like a missing zone. I would check the record in the private zone before changing the association. If the public answer is intended for the VPC, the design needs a different name or a deliberate split-horizon record.",
    followUps: [
      "How would you distinguish this from an unassociated VPC?",
      "What does the Resolver query log show?",
      "When is NXDOMAIN the safer answer?",
    ],
    redFlags: [
      "Says the public record is the fallback.",
      "Deletes the public zone first.",
      "Assumes the association is wrong.",
    ],
    rubric: [
      "States NXDOMAIN.",
      "Explains the private match takes precedence.",
      "Checks the private record.",
      "Articulates the privacy benefit.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every private hosted zone lists its associated VPCs and the owner of each association.",
      "Internal-only names are checked against all public hosted zones, including wildcards.",
      "Split-horizon zones document which audience gets which answer.",
      "VPC DNS support and DNS hostnames are enabled where private zones are used.",
      "On-premises resolution uses an inbound Resolver endpoint in an associated VPC.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Resolve the name from the internet and from the affected VPC before changing anything.",
      "Check the private zone association for the query source.",
      "Check the record in the zone that should answer, including the record type.",
      "Search public zones for the exact name and wildcard coverage.",
      "Review Resolver query logs for the source VPC and response code.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Remove or rename the public record if the name is internal only.",
      "Associate the missing VPC or create the missing private record.",
      "Re-test from every source and confirm the answer source.",
      "Add a guardrail that detects internal names in public zones.",
    ],
  },
];

const references = [
  {
    title: "Working with private hosted zones",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/hosted-zones-private.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Private hosted zones, VPC association, and resolution only inside associated VPCs or hybrid paths.",
  },
  {
    title: "Considerations when working with a private hosted zone",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/hosted-zone-private-considerations.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Split-view DNS, DNS support and hostnames, overlapping namespaces, and private-match NXDOMAIN behavior.",
  },
  {
    title: "What is Route 53 VPC Resolver?",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Default VPC resolution, private hosted zones, and inbound endpoints for hybrid access.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "private-zone-resolution": {
      model: privateHostedZonesModel,
      presets,
      instructions:
        "Start healthy, switch the source to the internet, then place the record in both zones. Compare the private answer with the public exposure, then test an unassociated VPC.",
      experimentIds: [experiment.id],
      note: "Illustrative query outcomes. Private-zone association, split-view DNS, and NXDOMAIN behavior follow the Route 53 documentation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-route53-routing",
    "cloud-networking-route53-resolver",
    "cloud-networking-vpc",
    "traffic-dns-ttl-failover",
    "cloud-networking-security-groups",
  ],
};
