import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASE_LATENCY_MS = 12;
const PLACEMENTS = [
  { id: 0, label: "same Availability Zone", short: "same AZ", perRtt: 0.4, costFactor: 0 },
  { id: 1, label: "another Availability Zone", short: "cross-AZ", perRtt: 1.2, costFactor: 1 },
  { id: 2, label: "another Region", short: "cross-region", perRtt: 60, costFactor: 5 },
];

const params = [
  {
    id: "placement",
    label: "Dependency placement",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Topology",
    help: "0 is the same Availability Zone, 1 is another AZ in the same Region, 2 is another Region. A Region contains multiple isolated AZs.",
    format: "count" as const,
  },
  {
    id: "roundTrips",
    label: "Serial round trips per request",
    min: 1,
    max: 50,
    step: 1,
    value: 5,
    unit: "",
    group: "Protocol",
    help: "How many request and response exchanges the call path makes before the request completes. Chatty protocols multiply the per-hop latency.",
    format: "count" as const,
  },
  {
    id: "requestRate",
    label: "Request rate",
    min: 100,
    max: 5000,
    step: 100,
    value: 500,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second. This model assumes every round trip carries the payload, which sets the transfer volume and cost.",
    format: "rps" as const,
  },
  {
    id: "payloadKB",
    label: "Payload per round trip",
    min: 1,
    max: 1000,
    step: 1,
    value: 10,
    unit: " KB",
    group: "Traffic",
    help: "Bytes carried in each direction per exchange. Larger payloads raise transfer volume; they do not raise the per-hop latency in this model.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  placement: number;
  placementLabel: string;
  placementShort: string;
  roundTrips: number;
  rate: number;
  payloadKB: number;
  latency: number;
  perRtt: number;
  transferTB: number;
  costIndex: number;
  serviceHealth: Health;
  networkHealth: Health;
  dependencyHealth: Health;
}

function compute(p: Params): Computed {
  const placement = Math.max(0, Math.min(2, Math.round(num(p, "placement", 1))));
  const roundTrips = Math.max(1, Math.round(num(p, "roundTrips", 5)));
  const rate = Math.max(1, num(p, "requestRate", 500));
  const payloadKB = Math.max(1, num(p, "payloadKB", 10));
  const place = PLACEMENTS[placement];
  const latency = BASE_LATENCY_MS + roundTrips * place.perRtt;
  const transferTB = rate * roundTrips * payloadKB * 0.00266;
  const costIndex = (transferTB * place.costFactor) / 10;
  const worst: Health =
    latency >= 500 || costIndex >= 80 ? "crit" : latency >= 250 || costIndex >= 40 ? "warn" : "ok";
  return {
    placement,
    placementLabel: place.label,
    placementShort: place.short,
    roundTrips,
    rate,
    payloadKB,
    latency,
    perRtt: place.perRtt,
    transferTB,
    costIndex,
    serviceHealth: worst,
    networkHealth: worst,
    dependencyHealth: worst,
  };
}

function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 20 }, (_, index) => {
      const wave = item.value * (0.98 + 0.04 * Math.sin((index + (seed % 4)) / 2.2));
      return item.format === "percent" ? clamp(wave, 0, 100) : Math.max(0, wave);
    });
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  return {
    t: 0,
    nodes: [
      {
        id: "service",
        label: "request service",
        kind: "service",
        health: v.serviceHealth,
        sublabel: `${formatNumber(v.rate)} rps · ${v.roundTrips} RTs`,
        detail: `Each request makes ${v.roundTrips} serial round trip${v.roundTrips === 1 ? "" : "s"} to its dependency. The service waits for each response before the next step.`,
        meta: { view: "flow" },
      },
      {
        id: "network",
        label: "network path",
        kind: "mesh",
        health: v.networkHealth,
        sublabel: `${v.placementShort} · ${v.perRtt} ms/RT`,
        detail: `The dependency sits in ${v.placementLabel}. This model uses ${v.perRtt} ms per round trip for the placement you selected, plus ${BASE_LATENCY_MS} ms of service baseline.`,
        meta: { view: "flow" },
      },
      {
        id: "dependency",
        label: "dependency",
        kind: "db",
        health: v.dependencyHealth,
        sublabel: `${formatNumber(v.transferTB)} TB/mo`,
        detail: `The dependency answers from ${v.placementShort}. Cross-AZ transfer is billed in both directions; cross-Region transfer is billed at a higher rate. The cost index here is relative, not a quote.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("service-network", "service", "network", 1, v.networkHealth),
      edge("network-dependency", "network", "dependency", 1, v.dependencyHealth),
    ],
    metrics: [
      metric("latency", "Dependency latency", v.latency, " ms", 250, 500, "ms"),
      metric("cost-index", "Transfer cost index", v.costIndex, "", 40, 80, "count"),
      metric(
        "transfer-tb",
        "Monthly transfer",
        v.transferTB,
        " TB",
        undefined,
        undefined,
        "number",
      ),
      metric("round-trips", "Serial round trips", v.roundTrips, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${v.placementShort}; ${formatNumber(v.latency)} ms per request across ${v.roundTrips} round trips; cost index ${formatNumber(v.costIndex)}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "latency",
    metricId: "latency",
    warn: 250,
    crit: 500,
    title: "The chatty call path breaches the latency budget",
    cause:
      "Each serial round trip pays the placement's latency. A cross-Region hop of tens of milliseconds, multiplied by many round trips, turns a small per-hop cost into a large request delay.",
    fix: "Reduce serial round trips, batch or cache the dependency, or move the dependency closer. Pinning the service and dependency in the same failure domain removes the per-hop cost but gives up isolation.",
    checkFirst: [
      "Count the serial round trips, not only the request rate.",
      "Confirm the actual placement and the measured per-hop latency.",
      "Check whether retries or DNS are adding round trips you did not plan.",
    ],
  },
  {
    id: "cost-index",
    metricId: "cost-index",
    warn: 40,
    crit: 80,
    title: "Transfer volume is crossing a billing boundary",
    cause:
      "Cross-AZ and cross-Region traffic is billed, and chatty protocols multiply the volume. The index combines placement, rate, payload, and round trips into a relative cost signal.",
    fix: "Move chatty dependencies into the same AZ, reduce payload or round trips, or use a local cache. Keep the cross-boundary traffic that is worth its isolation and availability.",
    checkFirst: [
      "Find which paths cross an AZ or Region boundary.",
      "Attribute volume to a service and a path with flow data.",
      "Check whether a chatty dependency can be co-located.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const crossAzRegionModel: SimModel = {
  id: "cloud-networking-cross-az-region",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = [];
    const jitter = rng.between(-0.4, 0.4);
    next.metrics = next.metrics.map((item) => {
      if (item.id === "latency") return { ...item, value: Math.max(0, item.value + jitter) };
      return item;
    });
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.placement > 0 && frame.flags.placementLogged !== values.placement) {
      pushEvent(next, {
        id: "cross-boundary",
        severity: values.latency >= 500 || values.costIndex >= 80 ? "crit" : "info",
        title: `Dependency is in ${values.placementLabel}`,
        detail: `Each request pays ${values.perRtt} ms per serial round trip. ${values.roundTrips} round trips add ${formatNumber(values.roundTrips * values.perRtt, 1)} ms before the dependency's own work.`,
        nodeId: "network",
        metricId: "latency",
      });
    }
    next.flags.placementLogged = values.placement;
    next.flags = { ...frame.flags, ...next.flags };
    next.summary = `${values.placementShort}; ${formatNumber(values.latency)} ms per request across ${values.roundTrips} round trips; cost index ${formatNumber(values.costIndex)}.`;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    items.push(
      `The dependency is in ${v.placementLabel}. Each serial round trip adds ${v.perRtt} ms, so ${v.roundTrips} round trips add ${formatNumber(v.roundTrips * v.perRtt, 1)} ms.`,
    );
    if (v.placement === 2) {
      items.push(
        "Cross-Region latency is large enough that a single hop can dominate a request. Multiply it by serial round trips before deciding the move is only a network problem.",
      );
    } else if (v.placement === 1) {
      items.push(
        "A single cross-AZ round trip is small. If the added delay is tens of milliseconds, count the round trips or check whether the move also crossed a Region or an extra hop.",
      );
    } else {
      items.push(
        "Same-AZ placement avoids the transfer charge and the per-hop delay, but it also gives up the failure isolation that a second AZ provides.",
      );
    }
    items.push(
      `Monthly transfer is about ${formatNumber(v.transferTB)} TB at this rate and payload. The cost index is relative and illustrative, not a current price quote.`,
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
    description:
      "A cross-AZ dependency with five serial round trips: 18 ms and a small transfer index.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Chatty peak",
    description:
      "Cross-AZ with 14 round trips and a larger payload. Latency is fine; the transfer index warns.",
    tone: "warn",
    params: defaults({ placement: 1, roundTrips: 14, requestRate: 1000, payloadKB: 20 }),
  },
  {
    id: "failure",
    label: "Cross-Region chatty",
    description:
      "A cross-Region dependency with 30 serial round trips breaches latency and cost together.",
    tone: "crit",
    params: defaults({ placement: 2, roundTrips: 30, requestRate: 1000, payloadKB: 20 }),
  },
  {
    id: "region",
    label: "Cross-Region, chunky",
    description:
      "Two round trips across Regions: latency is higher but stays below the warning line.",
    tone: "info",
    params: defaults({ placement: 2, roundTrips: 2, requestRate: 300, payloadKB: 10 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "The dependency returns to the same AZ. Latency drops and transfer cost returns to zero.",
    tone: "ok",
    params: defaults({ placement: 0, roundTrips: 10, requestRate: 800, payloadKB: 10 }),
  },
];

const experiment: Experiment = {
  id: "predict-cross-az-latency",
  title: "Predict whether the AZ move explains 30 ms",
  simId: "placement-path",
  question:
    "A service moved a dependency from its own Availability Zone to another AZ in the same Region. The p50 request time rose by about 30 ms. Is the AZ boundary the likely explanation?",
  prediction: {
    options: [
      { id: "az-30", label: "Yes. A cross-AZ round trip normally adds about 30 ms." },
      {
        id: "chatty",
        label:
          "Not from one round trip. It fits only if the call path makes many serial round trips or another hop was added.",
      },
      { id: "only-peak", label: "Yes, but only at peak request rate." },
      { id: "free", label: "No. Cross-AZ traffic has no latency and no charge." },
    ],
    correctOptionId: "chatty",
    explanation:
      "A single cross-AZ round trip adds sub-millisecond to low-single-digit milliseconds, not 30 ms. A 30 ms increase can come from a chatty protocol that makes dozens of serial round trips, a move that also crossed a Region, retries, or another hop. The model shows the chatty case: 25 round trips at 1.2 ms each add about 30 ms.",
  },
  setup: defaults({ placement: 1, roundTrips: 25, requestRate: 800, payloadKB: 10 }),
  runFor: 20,
  observe: [
    "Dependency latency is about 42 ms: 12 ms of baseline plus 25 round trips at 1.2 ms.",
    "Placement is cross-AZ, not cross-Region, so the per-hop cost is small.",
    "The transfer index warns because 25 round trips also multiply volume.",
    "Reducing the round trips lowers latency without changing the placement.",
    "Moving back to the same AZ removes the 30 ms but also gives up AZ isolation.",
  ],
  explain:
    "Latency is per round trip, and applications add the round trips together. The AZ boundary is real but small. Before blaming the network, count the serial exchanges and confirm the placement. A chatty protocol will make any boundary look expensive.",
  fix: defaults({ placement: 0, roundTrips: 25, requestRate: 800, payloadKB: 10 }),
  debrief:
    "Same-AZ placement removes the 30 ms and the transfer charge, but it also removes the isolation. The better fix may be fewer round trips or a local cache, which keeps the dependency in another AZ and still meets the latency budget.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Availability Zone (AZ) is an isolated failure domain inside a Region. AZs have separate power, cooling, and network, and they are close enough that a round trip between them is short. A Region is a larger geographic boundary; a cross-Region round trip is tens of milliseconds and depends on distance.",
  },
  {
    type: "p",
    text: "Cross-AZ traffic stays inside the Region but crosses an AZ boundary. It adds a small latency and a per-GB transfer charge in each direction. Cross-Region traffic crosses a Region boundary, adds much more latency, and is billed at a higher rate. Same-AZ traffic avoids both the boundary charge and most of the added delay.",
  },
  {
    type: "p",
    text: "The application shape decides whether the difference matters. One round trip across an AZ is small. A protocol that makes 25 serial round trips pays the cost 25 times. That is why a dependency move can look like a network regression when the real multiplier is the call pattern.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is service, network interface, AZ boundary or Region boundary, dependency. The request direction and the response direction both cross it. The placement of the dependency, not only the placement of the service, sets the failure domain and the latency.",
  },
  {
    type: "table",
    headers: ["Placement", "Added round-trip latency", "Transfer charge", "Failure isolation"],
    rows: [
      ["Same AZ", "Very small", "None for the AZ boundary", "Shares the AZ failure domain"],
      [
        "Cross-AZ",
        "Small, low single-digit ms",
        "Per GB in each direction",
        "Survives one AZ failure",
      ],
      [
        "Cross-Region",
        "Tens of ms, distance-dependent",
        "Higher per GB",
        "Survives a Region failure",
      ],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Dependency placement: same AZ, another AZ, or another Region.",
      "Serial round trips per request, which multiply the per-hop delay.",
      "Dependency latency and the monthly transfer volume.",
      "A relative transfer cost index, labelled illustrative.",
      "The tradeoff between isolation and the latency and cost of crossing a boundary.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note the small cross-AZ cost. Raise the round trips to 25 and compare latency and transfer volume; the per-hop delay did not change, but the request did. Then switch to Cross-Region, and finally to the chunky preset to see a cross-Region path that stays inside budget because it is not chatty.",
  },
  {
    type: "p",
    text: "The per-round-trip latencies, the 12 ms baseline, and the cost index are illustrative. They are not measured values or current prices. Use them to reason about direction and multiplication, then measure your own path.",
  },
  { type: "sim", simId: "placement-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At five cross-AZ round trips, the dependency added 6 ms. At 25 round trips, it added 30 ms. The per-hop latency was the same. The call pattern changed the result, which is why the answer to a 30 ms regression starts with a count of serial exchanges.",
  },
  {
    type: "p",
    text: "The cross-Region failure added 1,800 ms at 30 round trips. A single cross-Region hop is already large; serial round trips make it larger. The transfer index crossed its critical line at the same time because volume is rate times payload times round trips.",
  },
  {
    type: "p",
    text: "The chunky cross-Region preset stayed below the latency warning with two round trips. Distance is not automatically a breach. The protocol shape and the budget decide.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Traces: dependency spans with per-hop duration, retries, and the number of serial calls.",
      "Placement: the AZ and Region of the service, the dependency, and any proxy or cache in between.",
      "Flow logs and cost data: which paths cross an AZ or Region boundary and how many bytes they carry.",
      "Latency distributions: p50 and p99, because a small per-hop delay can hide in the average and hurt the tail.",
      "DNS and connection setup: a new connection can add round trips that are not in the application's own count.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Count the serial round trips and confirm the placement before changing the network. If the per-hop latency is small, the multiplier is in the protocol. If the placement is cross-Region, the distance is the dominant term.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Trace one request and count the serial dependency calls, including retries and connection setup.",
      "Confirm the actual AZ and Region placement of both ends.",
      "Measure the per-hop latency on the real path; do not infer it from the placement label alone.",
      "If the protocol is chatty, batch, cache, or pipeline the calls before moving the service.",
      "If the placement is wrong, move the dependency closer or accept the boundary for isolation.",
      "Re-measure latency and transfer volume at peak, and check the tail rather than only the mean.",
      "Document the isolation and cost tradeoff so the next move does not undo it silently.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Same-AZ placement is the lowest-latency and lowest-cost option, but it shares a failure domain. A dependency in the same AZ fails with the service.",
      "Cross-AZ placement buys isolation from one AZ failure at a small latency and transfer cost. For chatty traffic, the transfer cost can be larger than the latency.",
      "Cross-Region placement buys Region isolation at a much higher latency and cost. It fits asynchronous or batch traffic better than a serial request path.",
      "Caching reduces round trips and transfer volume but adds a consistency problem and another component to operate.",
      "Batching reduces the multiplier but increases the payload per call and can add queueing delay. Measure the end-to-end result, not one hop.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "cross-az-30ms",
    question:
      "A dependency moved to another AZ and the service is 30 ms slower. How do you decide whether the AZ is responsible?",
    difficulty: 2,
    hints: ["One cross-AZ round trip is small.", "Count the serial exchanges."],
    answer:
      "I would trace one request and count the serial round trips to the dependency, including retries and connection setup. A single cross-AZ round trip is normally sub-millisecond to low single-digit milliseconds, so 30 ms is too large for one hop. If the path makes 25 or 30 serial calls, the small per-hop delay explains it. I would also confirm the dependency did not actually move to another Region, and check DNS, proxies, and retries for extra hops. Then I would compare p50 and p99 before and after the move.",
    followUps: [
      "What if the trace shows only one call?",
      "How would you confirm the placement?",
      "Which fix would you try first?",
    ],
    redFlags: [
      "Accepts the AZ explanation without counting hops.",
      "Blames the network before checking the trace.",
      "Looks only at the mean.",
    ],
    rubric: [
      "Counts serial round trips.",
      "Knows cross-AZ latency is small.",
      "Checks placement and extra hops.",
      "Uses traces and tail latency.",
    ],
  },
  {
    id: "cross-region-cost",
    question:
      "How do cross-AZ and cross-Region transfer costs change your placement decision for a chatty service?",
    difficulty: 2,
    hints: [
      "Cost follows volume across the boundary.",
      "Chattiness multiplies volume as well as latency.",
    ],
    answer:
      "Both boundaries are billed, and cross-Region is priced higher. A chatty service sends payload on every round trip, so the cost scales with rate, payload, and serial calls. I would attribute the bytes to the path first, then decide whether the dependency can be co-located, cached, or batched. I would keep cross-boundary traffic where the isolation is worth the cost, and move the chatter that is only an implementation detail.",
    followUps: [
      "How would you attribute the bytes?",
      "When is cross-Region worth it?",
      "What would you cache?",
    ],
    redFlags: [
      "Assumes cross-AZ is free.",
      "Ignores the payload per call.",
      "Moves everything to one AZ without discussing isolation.",
    ],
    rubric: [
      "Names both billing boundaries.",
      "Connects volume to chatter.",
      "Attributes cost to a path.",
      "Balances cost with isolation.",
    ],
  },
  {
    id: "placement-tradeoff",
    question:
      "When would you deliberately keep a dependency in another AZ despite the latency and cost?",
    difficulty: 3,
    hints: [
      "Availability is a requirement, not an accident.",
      "Not every path is latency-sensitive.",
    ],
    answer:
      "I would keep it there when the dependency must survive an AZ failure, when the traffic is asynchronous or batched, or when the latency still fits the budget. I would verify that the service and dependency do not share a single-AZ dependency elsewhere, because moving both into one AZ can create a larger failure domain than the latency saves. I would also check that the added cost is understood and owned, not just accepted by default.",
    followUps: [
      "How would you test the AZ failure?",
      "What makes a dependency latency-sensitive?",
      "How would you reduce the cost without moving it?",
    ],
    redFlags: [
      "Optimizes latency and ignores availability.",
      "Assumes all traffic is synchronous.",
      "Does not test the failure domain.",
    ],
    rubric: [
      "Names availability as the reason.",
      "Distinguishes traffic shapes.",
      "Checks the full failure domain.",
      "Owns the cost tradeoff.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The AZ and Region placement of each dependency is documented.",
      "Serial round trips per request are measured, not estimated from the call graph.",
      "Latency and transfer cost are attributed to the paths that cross a boundary.",
      "The SLO budget includes the per-hop cost of the chosen placement.",
      "A failure-domain review confirms the service does not depend on a single AZ.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Trace one request and count the dependency calls, retries, and connection setups.",
      "Confirm the actual placement of both ends.",
      "Measure per-hop latency before blaming the boundary.",
      "Check the tail, not only the mean.",
      "Compare transfer volume with the baseline.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reduce the multiplier or move the dependency, and record which one you chose.",
      "Re-measure latency and cost at peak.",
      "Check that the fix did not remove required isolation.",
      "Add a trace or dashboard for the serial-call count.",
    ],
  },
];

const references = [
  {
    title: "AWS fault isolation boundaries: Availability Zones",
    url: "https://docs.aws.amazon.com/whitepapers/latest/aws-fault-isolation-boundaries/availability-zones.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How AZs isolate failures and what a multi-AZ design does and does not protect.",
  },
  {
    title: "Regions and Zones",
    url: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The relationship between Regions and Availability Zones.",
  },
  {
    title: "Understanding data transfer charges",
    url: "https://docs.aws.amazon.com/cur/latest/userguide/cur-data-transfers-charges.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How cross-AZ and cross-Region transfer appears in cost and usage data.",
  },
  {
    title: "Overview of data transfer costs for common architectures",
    url: "https://aws.amazon.com/blogs/architecture/overview-of-data-transfer-costs-for-common-architectures/",
    publisher: "AWS Architecture Blog",
    kind: "docs" as const,
    note: "Architecture patterns that create cross-AZ and cross-Region transfer charges.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "placement-path": {
      model: crossAzRegionModel,
      presets,
      instructions:
        "Start Healthy, then raise the serial round trips and compare latency with the cost index. Switch placement to cross-Region, then try the chunky preset to see a long path that still fits.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Latency, volume, and the relative cost index are teaching values, not measurements or current prices.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-vpc",
    "cloud-networking-egress-cost",
    "cloud-networking-nat-gateway",
    "cloud-networking-direct-connect",
  ],
};
