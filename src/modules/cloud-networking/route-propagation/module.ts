import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, MAX_EVENTS, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ONPREM_PREFIX = "10.60.0.0/16";
const SPECIFIC_PREFIX = "10.60.4.0/24";
const DEMAND = 1_200;
const INSPECTION = "tgw-attach-inspection";
const VPN_PRIMARY = "tgw-attach-vpn-primary";
const VPN_BACKUP = "tgw-attach-vpn-backup";

type Path = "inspection" | "vpn-primary" | "vpn-backup";

const params = [
  {
    id: "specificPrefix",
    label: "Add 10.60.4.0/24",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Routes",
    help: "1 adds a more specific /24 route from the primary VPN attachment. Longest prefix match selects it before any /16 route is compared.",
    format: "count" as const,
  },
  {
    id: "staticRoute",
    label: "Static /16 to inspection",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Routes",
    help: "1 adds a static 10.60.0.0/16 route targeting the inspection attachment. A static route outranks a propagated route for the same prefix.",
    format: "count" as const,
  },
  {
    id: "vpnAsPath",
    label: "Backup VPN AS path",
    min: 1,
    max: 4,
    step: 1,
    value: 2,
    unit: "",
    group: "BGP",
    help: "AS path length on the backup VPN attachment. The primary is fixed at 2. Lower wins when both routes have the same prefix and the same attachment type. Equal values have no guaranteed order.",
    format: "count" as const,
  },
  {
    id: "returnViaInspection",
    label: "Return via inspection",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Return path",
    help: "1 sends return traffic through the stateful inspection attachment even when the forward path bypassed it. The firewall sees only one direction and drops the flow.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  specificPrefix: boolean;
  staticRoute: boolean;
  vpnAsPath: number;
  returnViaInspection: boolean;
  selected: Path;
  returnPath: Path;
  tie: boolean;
  asymmetric: boolean;
  inspected: boolean;
  hops: number;
  delivered: number;
  dropped: number;
  deliveryRate: number;
  sourceHealth: Health;
  tableHealth: Health;
  inspectionHealth: Health;
  primaryHealth: Health;
  backupHealth: Health;
  onpremHealth: Health;
}

function compute(p: Params): Computed {
  const specificPrefix = num(p, "specificPrefix", 0) >= 0.5;
  const staticRoute = num(p, "staticRoute", 1) >= 0.5;
  const vpnAsPath = Math.max(1, Math.round(num(p, "vpnAsPath", 2)));
  const returnViaInspection = num(p, "returnViaInspection", 0) >= 0.5;
  const tie = !specificPrefix && !staticRoute && vpnAsPath === 2;

  let selected: Path = "vpn-primary";
  if (specificPrefix) selected = "vpn-primary";
  else if (staticRoute) selected = "inspection";
  else if (vpnAsPath < 2) selected = "vpn-backup";

  const returnPath: Path = returnViaInspection ? "inspection" : selected;
  const asymmetric = returnPath !== selected;
  const inspected = selected === "inspection";
  const delivered = asymmetric ? 0 : DEMAND;

  return {
    specificPrefix,
    staticRoute,
    vpnAsPath,
    returnViaInspection,
    selected,
    returnPath,
    tie,
    asymmetric,
    inspected,
    hops: inspected ? 2 : 1,
    delivered,
    dropped: DEMAND - delivered,
    deliveryRate: asymmetric ? 0 : 100,
    sourceHealth: asymmetric ? "warn" : "ok",
    tableHealth: asymmetric ? "crit" : tie ? "warn" : "ok",
    inspectionHealth: asymmetric && returnViaInspection ? "warn" : "ok",
    primaryHealth: selected === "vpn-primary" && asymmetric ? "crit" : "ok",
    backupHealth: selected === "vpn-backup" && asymmetric ? "crit" : "ok",
    onpremHealth: asymmetric ? "crit" : "ok",
  };
}

function pathLabel(path: Path): string {
  return path === "inspection" ? "inspection" : path === "vpn-primary" ? "vpn-primary" : "vpn-backup";
}

function routeLabel(v: Computed): string {
  if (v.specificPrefix) return `${SPECIFIC_PREFIX} → ${VPN_PRIMARY}`;
  if (v.staticRoute) return `${ONPREM_PREFIX} static → ${INSPECTION}`;
  return `${ONPREM_PREFIX} propagated → ${v.selected}`;
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = item.value * (0.99 + 0.02 * Math.sin((index + (seed % 7)) / 2.4));
      return item.format === "percent" ? clamp(wave, 0, 100) : Math.max(0, wave);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const forwardViaInspection = v.selected === "inspection";
  const forwardViaPrimary = v.selected === "vpn-primary";
  const forwardViaBackup = v.selected === "vpn-backup";
  const returnViaInspection = v.returnPath === "inspection";

  return {
    t: 0,
    nodes: [
      {
        id: "source",
        label: "spoke-vpc",
        kind: "external",
        health: v.sourceHealth,
        throughput: v.delivered,
        sublabel: "10.0.0.0/16 · 1,200 flows/s",
        detail: `The source subnet route table sends ${ONPREM_PREFIX} to the transit gateway. The gateway route table decides the next attachment.`,
        meta: { view: "flow" },
      },
      {
        id: "route-table",
        label: "tgw route table",
        kind: "mesh",
        health: v.tableHealth,
        sublabel: routeLabel(v),
        detail: v.specificPrefix
          ? `${SPECIFIC_PREFIX} is the most specific match, so it wins before the static or propagated /16 routes are compared. The path bypasses inspection.`
          : v.staticRoute
            ? `The static ${ONPREM_PREFIX} route targets inspection. A static route has higher priority than a propagated route for the same prefix.`
            : `Only propagated ${ONPREM_PREFIX} routes remain. Both VPN attachments are the same attachment type, so the lower AS path wins. ${v.tie ? "At equal AS path length, AWS cannot guarantee a consistent order." : ""}`,
        meta: { view: "flow", selected: v.selected, route: routeLabel(v) },
      },
      {
        id: "inspection",
        label: INSPECTION,
        kind: "service",
        health: v.inspectionHealth,
        sublabel: forwardViaInspection ? "forward path" : v.returnViaInspection ? "return path only" : "bypassed",
        detail: v.inspected
          ? "The forward flow enters the stateful appliance. The return path also goes through this attachment, so both directions share the same flow state."
          : v.returnViaInspection
            ? "The forward flow bypassed the appliance, but the return flow arrives here. The appliance has no state for the flow and drops it."
            : "The forward and return flows both bypass inspection. Traffic works, but the stateful policy is not applied.",
        meta: { view: "flow" },
      },
      {
        id: "vpn-primary",
        label: VPN_PRIMARY,
        kind: "external",
        health: v.primaryHealth,
        sublabel: "BGP AS path 2",
        detail:
          "Primary Site-to-Site VPN attachment. It advertises the on-premises prefix with AS path length 2. It is the preferred path only after prefix length and route type are considered.",
        meta: { view: "flow" },
      },
      {
        id: "vpn-backup",
        label: VPN_BACKUP,
        kind: "external",
        health: v.backupHealth,
        sublabel: `BGP AS path ${v.vpnAsPath}`,
        detail:
          "Backup VPN attachment. Both VPN routes have the same prefix and attachment type; the shorter AS path wins. If the lengths are equal, AWS cannot guarantee a consistent route order.",
        meta: { view: "flow" },
      },
      {
        id: "onprem",
        label: "on-premises 10.60.0.0/16",
        kind: "external",
        health: v.onpremHealth,
        sublabel: v.asymmetric ? "return path differs" : "symmetric path",
        detail: v.asymmetric
          ? "The forward packet arrived through one attachment and the response left through another. A stateful appliance on one side sees half the flow."
          : "The forward and return directions use the same attachment path, so stateful inspection sees the whole flow.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("source-table", "source", "route-table", 1, "ok"),
      edge("table-inspection", "route-table", "inspection", forwardViaInspection ? 1 : 0, forwardViaInspection ? "ok" : "warn"),
      edge("inspection-primary", "inspection", "vpn-primary", forwardViaInspection ? 1 : 0, forwardViaInspection ? "ok" : "warn"),
      edge("table-primary", "route-table", "vpn-primary", forwardViaPrimary ? 1 : 0, forwardViaPrimary ? "ok" : "ok"),
      edge("table-backup", "route-table", "vpn-backup", forwardViaBackup ? 1 : 0, forwardViaBackup ? "ok" : "ok"),
      edge("primary-onprem", "vpn-primary", "onprem", forwardViaPrimary || forwardViaInspection ? 1 : 0, "ok"),
      edge("backup-onprem", "vpn-backup", "onprem", forwardViaBackup ? 1 : 0, "ok"),
      edge(
        "onprem-inspection",
        "onprem",
        "inspection",
        returnViaInspection ? 1 : 0,
        v.asymmetric ? "crit" : "ok",
        "return",
      ),
      edge(
        "onprem-table",
        "onprem",
        "route-table",
        returnViaInspection ? 0 : 1,
        "ok",
        "return",
      ),
      edge(
        "inspection-table",
        "inspection",
        "route-table",
        returnViaInspection ? 1 : 0,
        v.asymmetric ? "crit" : "ok",
      ),
      edge("table-source", "route-table", "source", v.delivered > 0 ? 1 : 0, v.delivered > 0 ? "ok" : "crit"),
    ],
    metrics: [
      metric("delivery-rate", "End-to-end delivery", v.deliveryRate, "%", undefined, undefined, "percent"),
      metric("asymmetric-flows", "Asymmetric flows", v.asymmetric ? DEMAND : 0, " /s", 1, 50, "rps"),
      metric("dropped-flows", "Dropped flows", v.dropped, " /s", 1, 50, "rps"),
      metric("inspected-flows", "Flows through inspection", v.inspected ? DEMAND : 0, " /s", undefined, undefined, "rps"),
      metric("path-hops", "Forward path hops (illustrative)", v.hops, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      selected: v.selected,
      asymmetric: v.asymmetric ? 1 : 0,
      tie: v.tie ? 1 : 0,
    },
    summary: `${ONPREM_PREFIX} selects ${pathLabel(v.selected)}; return via ${pathLabel(v.returnPath)}; ${
      v.asymmetric ? "asymmetric, dropped" : "symmetric, delivered"
    }.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "asymmetric-flows",
    metricId: "asymmetric-flows",
    warn: 1,
    crit: 50,
    title: "Forward and return traffic use different paths",
    cause:
      "The gateway route table selected one attachment for the forward flow, while the return route from the remote side selected a different attachment. A stateful appliance that sees only one direction drops the flow.",
    fix:
      "Make the route tables symmetric: send both directions through the same inspection attachment, or send both directions direct. Do not rely on connection tracking across two different paths.",
    checkFirst: [
      "Read the route table associated with the source attachment and the table associated with the remote attachment.",
      "Compare the selected attachment for the forward prefix with the return prefix.",
      "Check whether a more specific route bypasses an inspection attachment on one side only.",
    ],
  },
  {
    id: "dropped-flows",
    metricId: "dropped-flows",
    warn: 1,
    crit: 50,
    title: "Traffic is dropped after asymmetric routing",
    cause:
      "Each direction followed a valid route, but the pair did not form a symmetric flow. The stateful firewall or NAT device on one path never saw the request, so it discarded the response.",
    fix:
      "Restore symmetry before adding capacity or changing the destination. Remove the route that bypasses inspection, or route the return path through the same attachment as the forward path.",
    checkFirst: [
      "Confirm the drop is on the return path, not the request path.",
      "Look for a stateful appliance, firewall, or NAT device between the two attachments.",
      "Compare the forward and return attachment IDs, not just the destination CIDRs.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const routePropagationModel: SimModel = {
  id: "cloud-networking-route-propagation",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p) => {
    const v = compute(p);
    const previousPath = String(frame.flags.selected ?? "");
    const previousAsymmetry = Number(frame.flags.asymmetric ?? 0);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events].slice(-MAX_EVENTS);
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, values]) => [key, [...values]]),
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (previousPath && previousPath !== v.selected) {
      pushEvent(next, {
        id: "selected-path-change",
        at: frame.t,
        severity: v.asymmetric ? "crit" : "info",
        title: `Selected path changed to ${pathLabel(v.selected)}`,
        detail: `${routeLabel(v)} now wins the lookup. ${v.asymmetric ? "The return path still uses a different attachment, so the flow is asymmetric." : "Forward and return paths are symmetric."}`,
        nodeId: "route-table",
        metricId: v.asymmetric ? "asymmetric-flows" : "delivery-rate",
      });
    }
    if (previousAsymmetry === 0 && v.asymmetric) {
      pushEvent(next, {
        id: "asymmetric-path",
        at: frame.t,
        severity: "crit",
        title: "Asymmetric path detected",
        detail: `Forward traffic uses ${pathLabel(v.selected)}, but the return path uses ${pathLabel(v.returnPath)}. A stateful inspection device sees only one direction and drops the flow.`,
        nodeId: "route-table",
        metricId: "asymmetric-flows",
      });
    }
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (v.specificPrefix) {
      items.push(
        `${SPECIFIC_PREFIX} is the longest matching prefix, so it wins before route type and BGP attributes are considered. The static /16 and the propagated /16 are never compared.`,
      );
    } else if (v.staticRoute) {
      items.push(
        `Both the static and propagated routes cover ${ONPREM_PREFIX}. The static route wins because route type breaks the tie at the same prefix length.`,
      );
    } else if (v.vpnAsPath < 2) {
      items.push(
        `Both VPN attachments advertise ${ONPREM_PREFIX}. With the same prefix and attachment type, the backup's shorter AS path (${v.vpnAsPath}) wins over the primary's path length of 2.`,
      );
    } else if (v.tie) {
      items.push(
        `Both VPN attachments advertise ${ONPREM_PREFIX} with AS path length 2. AWS does not guarantee a consistent order when the prefix, attachment type, and BGP attributes are equal.`,
      );
    } else {
      items.push(
        `Both VPN attachments advertise ${ONPREM_PREFIX}. The primary's AS path length of 2 beats the backup's ${v.vpnAsPath}.`,
      );
    }
    if (v.asymmetric) {
      items.push(
        `Forward traffic selects ${pathLabel(v.selected)}, but return traffic selects ${pathLabel(v.returnPath)}. Each route is individually valid; the pair is not. The stateful appliance drops the response because it never saw the request.`,
      );
    } else if (!v.inspected) {
      items.push(
        "Forward and return paths are symmetric, but they bypass the inspection attachment. Connectivity works; the security policy does not.",
      );
    } else {
      items.push(
        "Forward and return traffic both traverse the inspection attachment, so stateful inspection sees the complete flow.",
      );
    }
    items.push(
      `The route table shows only the preferred route. A backup route may not appear until the preferred route is withdrawn. Route presence in a table is not the same as a usable symmetric path.`,
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
    label: "Inspected and symmetric",
    description: "Static /16 sends both directions through inspection; delivery completes.",
    tone: "ok",
    params: defaults({ staticRoute: 1, specificPrefix: 0, returnViaInspection: 0, vpnAsPath: 2 }),
  },
  {
    id: "peak",
    label: "More specific direct path",
    description: "The /24 wins and bypasses inspection in both directions; traffic works without inspection.",
    tone: "info",
    params: defaults({ staticRoute: 1, specificPrefix: 1, returnViaInspection: 0, vpnAsPath: 2 }),
  },
  {
    id: "failure",
    label: "Asymmetric inspection",
    description: "Forward traffic goes direct over the VPN while the return goes through inspection.",
    tone: "crit",
    params: defaults({ staticRoute: 0, specificPrefix: 0, returnViaInspection: 1, vpnAsPath: 2 }),
  },
  {
    id: "backup",
    label: "Shorter backup AS path",
    description: "No static or more specific route; the backup VPN wins on AS path length and both directions stay direct.",
    tone: "info",
    params: defaults({ staticRoute: 0, specificPrefix: 0, returnViaInspection: 0, vpnAsPath: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The static route to inspection is restored and both directions are symmetric.",
    tone: "ok",
    params: defaults({ staticRoute: 1, specificPrefix: 0, returnViaInspection: 0, vpnAsPath: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-more-specific",
  title: "Predict the winning route",
  simId: "tgw-routes",
  question:
    "The gateway route table has a static 10.60.0.0/16 route to the inspection attachment and a propagated 10.60.4.0/24 route from the primary VPN attachment. The return path goes through inspection. Which forward path wins, and what happens?",
  prediction: {
    options: [
      { id: "specific", label: "The /24 wins, bypasses inspection, and the asymmetric return is dropped." },
      { id: "static", label: "The static /16 wins because static routes always outrank propagated routes." },
      { id: "ecmp", label: "Both routes are used equally because they overlap." },
      { id: "as-path", label: "The VPN with the shorter AS path wins before prefix length is checked." },
    ],
    correctOptionId: "specific",
    explanation:
      "Longest prefix match is evaluated first. The /24 is more specific than the /16, so it wins before route type or BGP attributes matter. It sends forward traffic direct, while the return path still goes through inspection, so the stateful appliance drops the response.",
  },
  setup: defaults({ specificPrefix: 1, staticRoute: 1, returnViaInspection: 1, vpnAsPath: 2 }),
  runFor: 20,
  observe: [
    "The selected route is 10.60.4.0/24 to the primary VPN attachment.",
    "The static 10.60.0.0/16 route still exists but is not selected.",
    "Forward traffic bypasses inspection while return traffic enters it.",
    "All 1,200 flows per second are asymmetric and dropped.",
    "Each route is valid in isolation; the pair is not symmetric.",
  ],
  explain:
    "Route lookup compares prefix length first. A /24 always beats a /16 for a destination inside the /24, no matter whether the /16 is static or propagated. Route type and BGP attributes only break ties between routes with the same prefix. The forward path is therefore direct, but the return path is pinned to inspection. The firewall never saw the request, so it drops the response.",
  fix: defaults({ specificPrefix: 0, staticRoute: 1, returnViaInspection: 0, vpnAsPath: 2 }),
  debrief:
    "The static route did not lose because static routes are weak. It lost because it was less specific. In production, look for a more specific route before blaming BGP, and check both directions before changing the forward table. Symmetry is a property of the pair, not of one route.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A transit gateway route table is a layer-3 routing table. Each route maps a destination CIDR to an attachment. Routes arrive in two ways: you create a static route, or an attachment propagates routes into the table. A VPC attachment propagates the VPC CIDRs. A VPN or Direct Connect attachment propagates routes learned over BGP. An attachment is associated with one route table and can propagate into one or more tables.",
  },
  {
    type: "p",
    text: "The lookup is ordered. The most specific prefix wins first. Only when two routes have the same prefix does route type matter, and only when the type is the same do BGP attributes such as AS path length, MED, and eBGP versus iBGP matter. A static route outranks a propagated route for the same prefix. Among propagated routes, the attachment type has a documented priority; VPC-propagated routes rank ahead of Direct Connect gateway and VPN-propagated routes.",
  },
  {
    type: "p",
    text: "That order explains most surprises. A /24 from a backup path beats a /16 from the preferred path. A static /16 beats a BGP route for the same /16. Two VPN attachments with the same prefix are compared on BGP attributes, and if those are equal, AWS cannot guarantee a consistent order. The table shows the preferred route; the backup may not appear until the preferred one is withdrawn.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The forward path starts in the source VPC's subnet route table, which sends the destination prefix to the transit gateway. The attachment's associated gateway route table selects the next attachment. At the destination, the VPC route table selects the subnet. The return path repeats the same process in reverse with a different route table. Each direction can select a different attachment, and that is how asymmetry begins.",
  },
  {
    type: "table",
    headers: ["Destination", "Target", "Route type", "Result"],
    rows: [
      ["10.60.4.0/24", "vpn-primary", "propagated", "Wins on longest prefix."],
      ["10.60.0.0/16", "inspection", "static", "Wins over a propagated /16."],
      ["10.60.0.0/16", "vpn-primary", "propagated", "Hidden by the static route."],
      ["10.60.0.0/16", "vpn-backup", "propagated", "Compared on AS path if no static route exists."],
      ["0.0.0.0/0", "inspection", "static", "Catch-all, only if no longer prefix matches."],
    ],
  },
  {
    type: "p",
    text: "The table is per attachment association. Two attachments can be on the same gateway and see different tables. A route that exists in one table does not exist in another. Segmentation is useful, but it also means a route change must be applied to every table that carries the flow.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "The selected route and its route type: more specific, static, or propagated.",
      "The backup VPN's AS path length, which only matters when prefix and route type are equal.",
      "Forward and return attachment IDs, so asymmetry is visible as a pair mismatch.",
      "Delivery, asymmetric flows, dropped flows, and inspected flows.",
      "Forward path hops as an illustrative count, not a latency measurement.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with the inspected, symmetric path. Add the /24 and watch it win before the static /16 is considered. Then remove the static route and lower the backup AS path. Finish by sending the return path through inspection while the forward path is direct. Read the forward and return attachment names together, not just the delivery number.",
  },
  {
    type: "p",
    text: "The flow rate of 1,200 per second, the path-hop count, and the route entries are illustrative teaching values. The route evaluation order, static-versus-propagated priority, and BGP tie-breaking rules follow AWS documentation.",
  },
  { type: "sim", simId: "tgw-routes" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The more specific /24 won the lookup before the static /16 was compared. Route type and AS path never entered the decision. The forward flow bypassed inspection, while the return flow still used the inspection attachment. The firewall saw a response without a request and dropped it.",
  },
  {
    type: "p",
    text: "Without the /24, the static /16 beat the propagated /16. That is a same-prefix tie broken by route type, not by prefix length. Removing the static route exposed the VPN comparison: the lower AS path won, and both directions stayed on the same attachment because the return path followed the selected path.",
  },
  {
    type: "p",
    text: "At equal AS path length, the model picks the primary but marks the table as a tie. AWS does not guarantee a consistent order in that case, so the safe design is to make one path deliberately preferred rather than rely on an accident of ordering.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "The transit gateway route table shows the selected route and its type. A backup route may be absent until the preferred route is withdrawn.",
      "The source and destination VPC route tables can both be correct while the gateway tables select different paths in each direction.",
      "A stateful firewall, NAT device, or load balancer in the path drops the half-flow. The application sees a timeout, not a routing error.",
      "Flow logs on both attachments show the request on one and the response on another. Comparing attachment IDs is faster than comparing IP addresses alone.",
      "A more specific route added for a maintenance window can silently bypass inspection. It wins even if the intent was to prefer the static route.",
      "BGP attributes are visible on the attachment routes, but the gateway displays only the preferred route. Do not infer that the backup path is unusable from its absence.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the longest-prefix match before anything else. Then compare route type at the same prefix. Then compare AS path within the same attachment type. Finally, write down the forward and return attachment IDs. If they differ, fix symmetry before touching BGP timers or adding capacity.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Find the exact destination prefix and the route that wins the longest-prefix match in each direction.",
      "Record the route type and attachment for the forward and return paths.",
      "If a more specific route bypassed inspection, remove it or route the return path the same way.",
      "If a static route is intended to win, confirm no more specific route exists for the destination.",
      "If two propagated routes tie, adjust AS path or MED deliberately, or use a static route to make the preference explicit.",
      "Verify both directions with a real flow, then repeat at the prefix level that the application actually uses.",
      "Document the route table associations and the intended symmetry so the next route change does not recreate the asymmetry.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A more specific route is a precise traffic-engineering tool, but it silently overrides broader policy. It is easy to add and easy to forget.",
      "Static routes make preference explicit and beat propagated routes at the same prefix, but they do not adapt to a failed attachment unless you withdraw them.",
      "BGP attributes let the network choose a backup automatically, but equal attributes have no guaranteed order. Design a deliberate preference instead of relying on a tie.",
      "Sending all traffic through inspection is symmetric and auditable, at the cost of an extra hop and a shared appliance that must scale.",
      "Bypassing inspection for a direct path improves the path but removes the policy. If the requirement is inspection, symmetry is not optional.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "longest-prefix-first",
    question:
      "A static 10.60.0.0/16 route points to an inspection attachment. A propagated 10.60.4.0/24 route points to a VPN attachment. Which one wins, and why?",
    difficulty: 2,
    hints: [
      "Compare prefix length before route type.",
      "The /24 is inside the /16.",
    ],
    answer:
      "The /24 wins because the gateway evaluates the most specific prefix first. The static /16 is only compared with other routes for 10.60.0.0/16, and the /24 is a different, longer prefix. Route type and BGP attributes do not get a chance to override prefix length. That can bypass inspection even though the static route was intended to force traffic through it. I would check whether the /24 is necessary, remove it if not, and make sure the return path uses the same attachment as the forward path.",
    followUps: [
      "When would the static route win?",
      "How would you detect the bypass?",
      "What if the /24 is required for a specific subnet?",
    ],
    redFlags: [
      "Says static routes always win.",
      "Compares AS path before prefix length.",
      "Ignores the return path.",
    ],
    rubric: [
      "States longest-prefix match first.",
      "Explains that route type only breaks same-prefix ties.",
      "Identifies the inspection bypass.",
      "Checks symmetry.",
    ],
  },
  {
    id: "same-prefix-tie",
    question:
      "Two VPN attachments advertise the same 10.60.0.0/16 prefix with the same AS path length and MED. Which path does the transit gateway use?",
    difficulty: 3,
    hints: [
      "Same prefix, same attachment type, same attributes.",
      "AWS documents what it cannot guarantee.",
    ],
    answer:
      "There is no guaranteed consistent choice. AWS evaluates the most specific prefix first, then route type, then BGP attributes such as AS path length and MED. If the prefix, attachment type, and attributes are all equal, AWS cannot guarantee a consistent order. The table shows only the preferred route, and the other may not appear until the preferred route is withdrawn. I would not design redundancy around a tie. I would make the preference explicit with a shorter AS path, a lower MED, or a static route, and verify the return path uses the same attachment.",
    followUps: [
      "How would you make the primary deliberately preferred?",
      "Why is the backup route not always visible?",
      "What happens when the primary is withdrawn?",
    ],
    redFlags: [
      "Names a deterministic winner.",
      "Claims ECMP across the two VPNs by default.",
      "Ignores the return direction.",
    ],
    rubric: [
      "Says the order is not guaranteed.",
      "Names AS path and MED as attributes.",
      "Makes the preference explicit.",
      "Mentions route visibility and failover.",
    ],
  },
  {
    id: "asymmetry-debug",
    question:
      "Requests reach an on-premises service, but responses never return. Forward and return route tables both contain the destination prefix. What do you compare next?",
    difficulty: 3,
    hints: [
      "A route can be valid in each direction and still be asymmetric.",
      "Look for a stateful device.",
    ],
    answer:
      "I would compare the attachment selected in each direction, not just whether a route exists. If the forward flow goes through a stateful inspection attachment and the return flow goes direct, or the reverse, the appliance sees only half the flow and drops it. I would read the gateway route table associated with the source attachment and the one associated with the remote attachment, then trace the return prefix. I would also check for a more specific route that bypasses inspection on one side. The fix is to make both directions use the same attachment path, or to remove the stateful device from one side if inspection is not required.",
    followUps: [
      "How would flow logs show the mismatch?",
      "What does appliance mode change?",
      "Would a static route on one side fix it?",
    ],
    redFlags: [
      "Only checks the forward route table.",
      "Blames BGP without checking the return attachment.",
      "Adds a new route without restoring symmetry.",
    ],
    rubric: [
      "Compares forward and return attachment IDs.",
      "Names the stateful device as the drop point.",
      "Checks for a more specific bypass.",
      "Restores symmetry rather than adding capacity.",
    ],
  },
];

const checklist = [
  {
    title: "Before the change",
    items: [
      "The intended forward and return attachment for each critical prefix is written down.",
      "Every more specific route that could override the intended path is listed.",
      "Static and propagated routes for the same prefix are compared deliberately.",
      "BGP attributes have a clear preference; no critical path relies on an equal-attribute tie.",
      "Stateful inspection points are identified on both directions.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the longest-prefix match before checking route type or AS path.",
      "Compare the attachment IDs used in each direction.",
      "Look for a more specific route added for maintenance or a migration.",
      "Check whether a stateful appliance sits on only one of the two paths.",
      "Confirm the route table association for each attachment, not only the route entry.",
    ],
  },
  {
    title: "After the change",
    items: [
      "Test the forward and return path as a pair, not as two independent pings.",
      "Confirm the selected route is the intended one in every table that carries the flow.",
      "Remove temporary more-specific routes and document any that remain.",
      "Record the BGP preference and the failover behavior.",
    ],
  },
];

const references = [
  {
    title: "How AWS Transit Gateway works: route evaluation order",
    url: "https://docs.aws.amazon.com/vpc/latest/tgw/how-transit-gateways-work.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Longest prefix, route type priority, BGP attributes, and the no-guarantee tie case.",
  },
  {
    title: "Transit gateway route tables",
    url: "https://docs.aws.amazon.com/vpc/latest/tgw/tgw-route-tables.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Association, propagation, and static routes in a gateway route table.",
  },
  {
    title: "Transit gateways in AWS Transit Gateway",
    url: "https://docs.aws.amazon.com/vpc/latest/tgw/tgw-transit-gateways.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Attachment types, static and dynamic routing, and route table segmentation.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "tgw-routes": {
      model: routePropagationModel,
      presets,
      instructions:
        "Start symmetric through inspection. Add the /24, remove the static route, change the AS path, then move the return path to inspection and compare the attachment pair.",
      experimentIds: [experiment.id],
      note: "Illustrative route model. Flow counts and hop counts are teaching values; route evaluation follows AWS Transit Gateway documentation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-peering-vs-tgw",
    "cloud-networking-route-tables",
    "cloud-networking-cross-account",
    "cloud-networking-vpn",
  ],
};
