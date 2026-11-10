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

const PATH_A_LATENCY_MS = 7;
const PATH_B_LATENCY_MS = 28;
const PEER_LOCAL_PREF = 100;
const PEER_AS_PATH = 2;
const PEER_MED = 50;

const params = [
  {
    id: "localPrefA",
    label: "Local preference, path A",
    min: 50,
    max: 200,
    step: 10,
    value: 150,
    unit: "",
    group: "Path A",
    help: "Higher is better. Local preference is the first common tie-breaker inside an autonomous system and is not advertised to external peers. Path B stays at 100.",
    format: "count" as const,
  },
  {
    id: "asPathA",
    label: "AS path length, path A",
    min: 1,
    max: 5,
    step: 1,
    value: 1,
    unit: "",
    group: "Path A",
    help: "Shorter is better. AS path prepending makes a path look longer without changing its capacity. Path B stays at 2.",
    format: "count" as const,
  },
  {
    id: "medA",
    label: "MED, path A",
    min: 0,
    max: 100,
    step: 10,
    value: 20,
    unit: "",
    group: "Path A",
    help: "Lower is better, but the Multi-Exit Discriminator (MED) is compared only between paths from the same neighbouring autonomous system. Path B stays at 50.",
    format: "count" as const,
  },
  {
    id: "pathAFailure",
    label: "Path A data-plane failure",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "1 breaks forwarding on path A. The BGP session can remain established when the failure is beyond the peer router, so the prefix can still be advertised.",
    format: "count" as const,
  },
  {
    id: "withdrawOnFailure",
    label: "Withdraw path A on failure",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Failover",
    help: "1 models BFD or an explicit prefix withdrawal that removes path A. 0 leaves the stale path in the table, where attributes can keep it selected.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  localPrefA: number;
  asPathA: number;
  medA: number;
  failure: boolean;
  withdraw: boolean;
  aPresent: boolean;
  aPreferred: boolean;
  selected: "A" | "B";
  stale: boolean;
  delivery: number;
  latency: number;
  reason: string;
  officeHealth: Health;
  pathAHealth: Health;
  pathBHealth: Health;
  routeHealth: Health;
  appHealth: Health;
}

function prefersA(localPrefA: number, asPathA: number, medA: number): boolean {
  if (localPrefA !== PEER_LOCAL_PREF) return localPrefA > PEER_LOCAL_PREF;
  if (asPathA !== PEER_AS_PATH) return asPathA < PEER_AS_PATH;
  if (medA !== PEER_MED) return medA < PEER_MED;
  return true;
}

function compute(p: Params): Computed {
  const localPrefA = num(p, "localPrefA", 150);
  const asPathA = Math.max(1, Math.round(num(p, "asPathA", 1)));
  const medA = num(p, "medA", 20);
  const failure = num(p, "pathAFailure", 0) >= 0.5;
  const withdraw = num(p, "withdrawOnFailure", 1) >= 0.5;
  const aPresent = !failure || !withdraw;
  const aPreferred = prefersA(localPrefA, asPathA, medA);
  const selected: "A" | "B" = aPresent && aPreferred ? "A" : "B";
  const stale = failure && selected === "A";
  const delivery = stale ? 0 : 100;
  const latency = selected === "A" ? PATH_A_LATENCY_MS : PATH_B_LATENCY_MS;
  const reason =
    localPrefA !== PEER_LOCAL_PREF
      ? `local preference ${localPrefA} versus ${PEER_LOCAL_PREF}`
      : asPathA !== PEER_AS_PATH
        ? `AS path length ${asPathA} versus ${PEER_AS_PATH}`
        : medA !== PEER_MED
          ? `MED ${medA} versus ${PEER_MED}`
          : "tie, so the older path stays selected";
  const officeHealth: Health = delivery === 100 ? "ok" : "crit";
  const pathAHealth: Health = failure ? "down" : "ok";
  const pathBHealth: Health = selected === "B" && !failure ? "warn" : "ok";
  const routeHealth: Health = stale ? "crit" : "ok";
  const appHealth: Health = delivery === 100 ? "ok" : "crit";
  return {
    localPrefA,
    asPathA,
    medA,
    failure,
    withdraw,
    aPresent,
    aPreferred,
    selected,
    stale,
    delivery,
    latency,
    reason,
    officeHealth,
    pathAHealth,
    pathBHealth,
    routeHealth,
    appHealth,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 20 }, (_, index) => {
      const wave = item.value * (0.98 + 0.04 * Math.sin((index + (seed % 7)) / 2.6));
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
        id: "office",
        label: "on-premises router",
        kind: "client",
        health: v.officeHealth,
        sublabel: "one prefix, two paths",
        detail:
          "The office advertises the same prefix over two paths. BGP installs one best path per prefix; it does not average the two.",
        meta: { view: "flow" },
      },
      {
        id: "path-a",
        label: "path A · Direct Connect",
        kind: "external",
        health: v.pathAHealth,
        sublabel: v.failure
          ? v.withdraw
            ? "failed, withdrawn"
            : "failed, still advertised"
          : "forwarding",
        detail: `Direct Connect path with ${PATH_A_LATENCY_MS} ms latency. Local preference ${v.localPrefA}, AS path ${v.asPathA}, MED ${v.medA}. ${
          v.failure
            ? v.withdraw
              ? "The prefix is withdrawn, so it cannot be selected."
              : "The data plane is broken but the prefix is still advertised; BGP has no reason to remove it."
            : "The path is healthy and eligible."
        }`,
        meta: { view: "flow", selected: v.selected === "A" ? 1 : 0 },
      },
      {
        id: "path-b",
        label: "path B · VPN",
        kind: "external",
        health: v.pathBHealth,
        sublabel: v.selected === "B" ? "selected, slower" : "standby",
        detail: `VPN path with ${PATH_B_LATENCY_MS} ms latency. Local preference ${PEER_LOCAL_PREF}, AS path ${PEER_AS_PATH}, MED ${PEER_MED}. It is always available in this model.`,
        meta: { view: "flow", selected: v.selected === "B" ? 1 : 0 },
      },
      {
        id: "route",
        label: "BGP decision",
        kind: "mesh",
        health: v.routeHealth,
        sublabel: `selects path ${v.selected}`,
        detail: `Path ${v.selected} wins by ${v.reason}. ${
          v.stale
            ? "The winning path cannot forward, so the decision is a blackhole."
            : "The winning path is eligible and forwarding."
        }`,
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "VPC workloads",
        kind: "service",
        health: v.appHealth,
        sublabel: `${v.delivery}% delivered`,
        detail:
          v.delivery === 100
            ? `Traffic follows path ${v.selected} at ${v.latency} ms.`
            : "No traffic completes. The selected path is stale, and BGP has not been told to withdraw it.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("office-a", "office", "path-a", v.selected === "A" ? 1 : 0, v.pathAHealth),
      edge("office-b", "office", "path-b", v.selected === "B" ? 1 : 0, v.pathBHealth),
      edge("a-route", "path-a", "route", v.selected === "A" ? 1 : 0, v.routeHealth),
      edge("b-route", "path-b", "route", v.selected === "B" ? 1 : 0, v.routeHealth),
      edge("route-app", "route", "app", v.delivery / 100, v.appHealth),
    ],
    metrics: [
      metric("drop", "End-to-end drop", 100 - v.delivery, "%", 0.5, 1, "percent"),
      metric("selected-latency", "Selected path latency", v.latency, " ms", 20, 40, "ms"),
      metric(
        "path-a-preference",
        "Path A local preference",
        v.localPrefA,
        "",
        undefined,
        undefined,
        "count",
      ),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `Path ${v.selected} selected by ${v.reason}; ${v.delivery}% delivered.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "drop",
    metricId: "drop",
    warn: 0.5,
    crit: 1,
    title: "The selected BGP path cannot forward",
    cause:
      "The best-path decision still points at path A after its data plane failed. BGP only changes the decision when the prefix is withdrawn or a better path appears; it does not probe application forwarding.",
    fix: "Withdraw the stale prefix with BFD or explicit policy, or change the attributes so the backup wins. Then confirm the backup is actually installed and forwarding.",
    checkFirst: [
      "Read the BGP table and the route table, not only the session state.",
      "Confirm whether the failed prefix is still advertised by the peer.",
      "Check the attribute that made path A win.",
    ],
  },
  {
    id: "selected-latency",
    metricId: "selected-latency",
    warn: 20,
    crit: 40,
    title: "Traffic is taking the slower path",
    cause:
      "Path A is healthy but its attributes lost the best-path comparison, so the longer-latency VPN path was selected. Local preference, then AS path, then MED outrank raw latency.",
    fix: "Fix the attribute that is wrong for the intended design. Raising local preference or shortening the AS path changes the decision; tuning latency metrics does not.",
    checkFirst: [
      "Compare local preference on both paths.",
      "Compare AS path length, including prepends.",
      "Check whether MED is comparable across the two peers.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const bgpModel: SimModel = {
  id: "cloud-networking-bgp",
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
    const jitter = rng.between(-0.2, 0.2);
    next.metrics = next.metrics.map((item) => {
      if (item.id === "selected-latency") {
        return { ...item, value: Math.max(0, item.value + jitter) };
      }
      return item;
    });
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.stale && frame.flags.staleLogged !== 1) {
      pushEvent(next, {
        id: "bgp-stale-path",
        severity: "crit",
        title: "BGP still prefers a failed path",
        detail: `Path A is selected by ${values.reason}, but forwarding is broken and the prefix was not withdrawn. The backup is healthy and unused.`,
        nodeId: "route",
        metricId: "drop",
      });
    }
    next.flags.staleLogged = values.stale ? 1 : 0;
    if (values.selected === "B" && !values.stale && frame.flags.slowSelected !== 1) {
      pushEvent(next, {
        id: "bgp-slow-path",
        severity: "warn",
        title: "The backup path is now primary",
        detail: `Path B wins by ${values.reason}. Delivery is intact, but every request pays ${values.latency} ms.`,
        nodeId: "path-b",
        metricId: "selected-latency",
      });
    }
    next.flags.slowSelected = values.selected === "B" && !values.stale ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.summary = `Path ${values.selected} selected by ${values.reason}; ${values.delivery}% delivered.`;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    items.push(
      `Path A wins on ${v.reason}. Local preference is compared before AS path, and both are compared before MED.`,
    );
    if (v.stale) {
      items.push(
        "The control plane still advertises a path the data plane cannot use. A session that stays up is not a health signal for forwarding.",
      );
    } else if (v.selected === "B") {
      items.push(
        `Path B is selected at ${PATH_B_LATENCY_MS} ms. Delivery is fine, but the slower path is now the primary path; fix the attribute if that is not the intent.`,
      );
    } else {
      items.push(
        `Path A is selected at ${PATH_A_LATENCY_MS} ms. The backup is available but less preferred, which is the expected steady state.`,
      );
    }
    items.push(
      "MED is comparable only between paths from the same neighbouring AS. Using it across different providers can produce a result you did not intend.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Slower path", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Path A wins on local preference and carries traffic at 7 ms.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Slower path",
    description:
      "Path A local preference drops below the VPN, so the 28 ms backup becomes primary.",
    tone: "warn",
    params: defaults({ localPrefA: 90 }),
  },
  {
    id: "failure",
    label: "Stale path",
    description:
      "Path A fails but its prefix is not withdrawn. Local preference keeps it selected.",
    tone: "crit",
    params: defaults({ localPrefA: 200, pathAFailure: 1, withdrawOnFailure: 0 }),
  },
  {
    id: "med",
    label: "MED tie-break",
    description: "Local preference and AS path tie; path A wins on the lower MED.",
    tone: "ok",
    params: defaults({ localPrefA: 100, asPathA: 2, medA: 10 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Path A is healthy, preferred, and selected again.",
    tone: "ok",
    params: defaults({ pathAFailure: 0, withdrawOnFailure: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-bgp-failover",
  title: "Predict which path carries traffic",
  simId: "bgp-paths",
  question:
    "Path A has local preference 200 and path B has 100. A data-plane failure breaks forwarding on path A, but its BGP session stays established and the prefix is still advertised. Which path carries traffic?",
  prediction: {
    options: [
      { id: "backup", label: "Path B, because path A failed." },
      { id: "stale", label: "Path A, because it still wins the best-path comparison." },
      { id: "ecmp", label: "Both, because BGP balances equal prefixes." },
      { id: "prepend", label: "Path B, because its AS path is shorter after the failure." },
    ],
    correctOptionId: "stale",
    explanation:
      "BGP chooses a path from the routes it has. If path A is still advertised, local preference 200 beats 100 and path A remains the best path. The data plane cannot forward, so traffic is dropped. BFD, an explicit withdrawal, or a routing policy change is needed to remove the stale path.",
  },
  setup: defaults({ localPrefA: 200, pathAFailure: 1, withdrawOnFailure: 0 }),
  runFor: 20,
  observe: [
    "End-to-end drop is 100% while the selected path latency stays at 7 ms.",
    "Path A is down but still selected; path B is healthy and unused.",
    "The BGP decision node is critical and the route table points at path A.",
    "No threshold fires on latency: the slowest path is not the failing one.",
    "Withdrawing path A returns the drop to 0% on path B.",
  ],
  explain:
    "Best-path selection is a comparison of attributes, not a liveness probe. A path can win the comparison and still be unable to forward. The failure is visible in the drop metric, not in the tunnel or session state.",
  fix: defaults({ localPrefA: 200, pathAFailure: 1, withdrawOnFailure: 1 }),
  debrief:
    "With path A withdrawn, path B is selected and delivery returns to 100%, now at 28 ms. The backup worked only after the stale path left the table. In production, test that the prefix is withdrawn and the backup is installed, not just that the backup session is up.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Border Gateway Protocol (BGP) exchanges reachability information between autonomous systems (AS). Each AS has a number. A router advertises a prefix with attributes, and the receiving router chooses one best path for that prefix. The decision is a ranked comparison, not a measurement of latency or loss.",
  },
  {
    type: "p",
    text: "The common order is: highest local preference, shortest AS path, lowest origin type, lowest MED, external over internal, then the oldest path. Local preference is local to your AS and is not sent to external peers. The Multi-Exit Discriminator (MED) is a hint to a neighbouring AS and is comparable only between paths from the same neighbour.",
  },
  {
    type: "p",
    text: "Failover depends on a route changing. If a path fails but the peer keeps advertising it, the best-path comparison can keep selecting it. A BGP session can stay established while forwarding is broken, which is why fast failure detection such as Bidirectional Forwarding Detection (BFD) matters.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is the office router, the provider or Direct Connect path, the AWS router, the virtual interface, the gateway, and the VPC route table. BGP runs on the edge. The VPC route table receives the result. The return direction is a separate advertisement and a separate decision.",
  },
  {
    type: "table",
    headers: ["Attribute", "Preference", "Scope", "Typical use"],
    rows: [
      ["Local preference", "Higher wins", "Inside one AS", "Choose the primary path"],
      ["AS path", "Shorter wins", "Across ASes", "Prefer a path or prepend to demote one"],
      ["MED", "Lower wins", "Same neighbour AS", "Influence inbound traffic from one peer"],
      ["Origin", "IGP over EGP over incomplete", "Across ASes", "Penalise redistributed routes"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Two paths for one prefix, with their local preference, AS path, and MED.",
      "The selected path and the attribute that decided it.",
      "End-to-end drop, which exposes a selected path that cannot forward.",
      "Selected path latency, which exposes a working but slower backup.",
      "A failure toggle and a withdrawal toggle, so control-plane and data-plane failures can be separated.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and read the decision reason. Lower path A's local preference to 90 and watch the slow path become primary; delivery stays at 100%, so the symptom is latency. Then restore it, fail path A without withdrawing it, and compare the delivery and latency metrics. The failing path is the fast one, so latency alone would mislead you.",
  },
  {
    type: "p",
    text: "Latencies of 7 ms and 28 ms and the attribute values are illustrative teaching inputs. They are not measurements of any specific Direct Connect or VPN path.",
  },
  { type: "sim", simId: "bgp-paths" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "When path A's local preference was 90, path B won. Delivery stayed at 100% and latency rose to 28 ms. Nothing failed; the design simply preferred the wrong path. The fix is an attribute change, not a repair.",
  },
  {
    type: "p",
    text: "When path A failed but stayed advertised, local preference 200 kept it selected. Delivery went to zero while the latency metric stayed at 7 ms. The control plane had no reason to withdraw the path, so the data plane failure was invisible to BGP.",
  },
  {
    type: "p",
    text: "Withdrawing path A moved the decision to path B and restored delivery, at the cost of the slower path. The backup had been healthy the whole time. The missing piece was the withdrawal, not the tunnel.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "BGP table: prefixes, next hops, local preference, AS path, MED, and the best-path marker.",
      "Session state: established, idle, or active, plus uptime and hold timer.",
      "Route table: the installed prefix and the next hop that won.",
      "Traffic: delivered rate and latency per path, not only per tunnel.",
      "Changes: attribute changes, route policy, prefix lists, and provider maintenance.",
      "Flow logs or captures: whether packets reached the far side after the decision.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the failed prefix is still advertised. If it is, BGP will keep selecting it according to the attributes, and the backup will stay idle. Then compare the attribute that won. Tunnel or session state is not enough.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the prefix and the two candidate paths. Record the attribute that decided the winner.",
      "Confirm whether the failed path is still advertised. If it is, withdraw it or enable fast failure detection.",
      "If the path is healthy but wrong, correct the attribute: local preference first, then AS path, then MED.",
      "Verify the backup is installed in the route table, not only present in the BGP table.",
      "Send real traffic and check delivery and latency on the new path.",
      "Add a test that fails the primary and asserts the backup is selected within the recovery objective.",
      "Document which attribute is intentional and which is a leftover from a previous design.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Local preference is the strongest common knob, but it is local to your AS and easy to set inconsistently across routers.",
      "AS path prepending is visible to neighbours and can influence their decisions, but it is a blunt instrument and can be overridden by local preference.",
      "MED can steer traffic from one neighbour, but it is not comparable across different neighbours and is often ignored.",
      "A shorter AS path is not a faster path. BGP does not measure latency, so a design that equates the two will be surprised.",
      "BFD speeds detection but adds a signal that can flap. Tune it against the link quality and the recovery objective.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "bgp-best-path",
    question:
      "Two paths advertise the same prefix. Path A has local preference 200, AS path length 4. Path B has local preference 100, AS path length 1. Which wins, and why?",
    difficulty: 3,
    hints: ["The comparison is ordered.", "Local preference is evaluated before AS path length."],
    answer:
      "Path A wins. Local preference is compared before AS path length, and 200 is higher than 100. The shorter AS path on B does not matter until the local preferences tie. I would confirm that both paths are from the same decision scope and that the local preference is actually configured on the router making the decision. Then I would check whether the result is intentional, because a high local preference can keep a long path selected even when a shorter one exists.",
    followUps: [
      "What if the local preferences were equal?",
      "Where would you change the preference?",
      "How could MED change the result?",
    ],
    redFlags: [
      "Picks the shorter AS path.",
      "Treats latency as a BGP attribute.",
      "Ignores the order of comparison.",
    ],
    rubric: [
      "Applies local preference first.",
      "Explains the ordered comparison.",
      "Checks configuration scope.",
      "Notes that the result may be unintended.",
    ],
  },
  {
    id: "bgp-up-no-traffic",
    question:
      "The BGP session is established, the prefix is present, and traffic is still dropped. How do you investigate?",
    difficulty: 4,
    hints: ["Separate control plane from data plane.", "The selected path can be stale."],
    answer:
      "I would verify the data plane separately from the session. First, which path is selected, and is that path actually forwarding? I would check interface counters, tunnel bytes, and flow logs on both ends. If the selected path is stale, I would check why the prefix is still advertised and whether BFD or a withdrawal is configured. I would also check the return path and the security policy, because a one-way forwarding failure looks similar. The key is not to treat session state as proof of delivery.",
    followUps: [
      "What signal would prove the data plane is broken?",
      "How does BFD change the timeline?",
      "What would you check on the return path?",
    ],
    redFlags: [
      "Restarts BGP immediately.",
      "Assumes an established session means forwarding.",
      "Checks only one direction.",
    ],
    rubric: [
      "Separates control and data planes.",
      "Checks the selected path and counters.",
      "Explains stale advertisements.",
      "Checks the return path and policy.",
    ],
  },
  {
    id: "bgp-med-scope",
    question: "Why is MED a weak failover signal across two different providers?",
    difficulty: 4,
    hints: [
      "MED is a hint, not a global ranking.",
      "It is comparable only between paths from the same neighbour AS.",
    ],
    answer:
      "MED is intended to tell one neighbouring AS which of several entry points you prefer. It is compared only between paths from the same neighbour AS, and providers can ignore it or strip it at their boundary. Across two providers, the values are not on a common scale, so a lower MED on one path does not reliably mean that path is preferred. I would use local preference for outbound control and treat MED as a hint only within one provider's scope.",
    followUps: [
      "What would you use instead for outbound preference?",
      "How could AS path prepending help?",
      "What happens if the provider ignores MED?",
    ],
    redFlags: [
      "Compares MED across providers as if it were global.",
      "Uses MED as the only failover mechanism.",
      "Confuses inbound and outbound control.",
    ],
    rubric: [
      "Explains MED scope.",
      "Names provider filtering.",
      "Suggests local preference for outbound.",
      "Distinguishes inbound from outbound.",
    ],
  },
  {
    id: "bgp-failover-test",
    question: "How do you prove that BGP failover works before you need it?",
    difficulty: 3,
    hints: [
      "A backup route in the table is not a tested failover.",
      "Test the failure mode and measure selection.",
    ],
    answer:
      "I would establish both sessions, confirm both prefixes are present, and record which one is best. Then I would fail the primary in a controlled way and measure how long it takes for the backup to be selected and for traffic to flow. I would test both a clean session failure and a data-plane failure that leaves the session up, because they produce different outcomes. I would also verify the return path and the capacity of the backup. The test passes only when real traffic completes within the recovery objective.",
    followUps: [
      "What is the difference between the two failure tests?",
      "How would you measure convergence?",
      "What would you do if the backup is selected but too small?",
    ],
    redFlags: [
      "Only checks that both sessions are up.",
      "Tests one failure mode.",
      "Does not measure traffic.",
    ],
    rubric: [
      "Tests selection, not just reachability.",
      "Covers control-plane and data-plane failures.",
      "Measures convergence and delivery.",
      "Checks capacity and return path.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every prefix has a documented primary and backup path with the attribute that decides each.",
      "Local preference, AS path, and MED are reviewed for unintended leftovers.",
      "BFD or timer settings match the recovery objective.",
      "The backup path is tested with the load it must carry.",
      "Alerts cover delivery and latency per path, not only session state.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether the failed prefix is still advertised.",
      "Read the best-path reason, not only the selected next hop.",
      "Confirm the selected path can forward with counters or flow logs.",
      "Check the return path and the policy on both sides.",
      "Record the attribute values before changing them.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Withdraw stale prefixes and remove temporary attribute changes.",
      "Re-test both failure modes and record convergence times.",
      "Document the intended primary and the reason it is preferred.",
      "Add a check for a stale best path.",
    ],
  },
];

const references = [
  {
    title: "Direct Connect routing and BGP",
    url: "https://docs.aws.amazon.com/directconnect/latest/UserGuide/routing-and-bgp.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "BGP sessions and route advertisement on Direct Connect virtual interfaces.",
  },
  {
    title: "RFC 4271: A Border Gateway Protocol 4 (BGP-4)",
    url: "https://datatracker.ietf.org/doc/html/rfc4271",
    publisher: "IETF",
    kind: "standard" as const,
    note: "The base BGP specification, including the decision process and path attributes.",
  },
  {
    title: "Site-to-Site VPN routing",
    url: "https://docs.aws.amazon.com/vpn/latest/s2svpn/VPNRoutingTypes.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How BGP and static routing install prefixes for VPN connections.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "bgp-paths": {
      model: bgpModel,
      presets,
      instructions:
        "Start Healthy, then compare the slower-path preset with the stale-path failure. Watch delivery and selected latency together; they point at different failures.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Path latencies and attribute values are teaching inputs, not measurements of a specific network. The MED tie-break assumes both paths come from the same neighbouring AS.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-direct-connect",
    "cloud-networking-vpn",
    "cloud-networking-route-propagation",
    "cloud-networking-route-tables",
  ],
};
