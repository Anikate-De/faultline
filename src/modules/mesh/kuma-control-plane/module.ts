import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, SimState, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CHECKOUT = 8;
const PAYMENTS = 4;
const TOTAL = CHECKOUT + PAYMENTS;
const TARGET_SHARE = 0.5;

const params = [
  {
    id: "selectorScope",
    label: "Selector match",
    min: 0,
    max: 3,
    step: 1,
    value: 3,
    unit: "",
    group: "Selector",
    help: "0: service `*`. 1: service checkout. 2: service checkout and version v2. 3: service checkout, version v2, and zone eu.",
    format: "count" as const,
  },
  {
    id: "v2Share",
    label: "Checkout workloads on v2",
    min: 0,
    max: 100,
    step: 10,
    value: 100,
    unit: "%",
    group: "Workloads",
    help: "Share of the eight checkout data plane proxies labeled version v2. The intended policy target is checkout v2 in the eu zone.",
    format: "percent" as const,
  },
  {
    id: "meshMatch",
    label: "Policy and workloads share a mesh",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Scope",
    help: "1 means all workloads are in the policy's mesh. 0 means half are in another mesh and cannot receive the policy.",
    format: "count" as const,
  },
  {
    id: "proxyCompat",
    label: "Sidecars support the policy version",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Versions",
    help: "1 means every selected sidecar understands the policy type. 0 means 30% run an older version that does not apply it.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  selectorScope: number;
  v2Share: number;
  meshMatch: boolean;
  proxyCompat: boolean;
  checkoutV2: number;
  target: number;
  selectedBase: number;
  selected: number;
  affected: number;
  overmatched: number;
  missed: number;
  missedShare: number;
}

function compute(p: Params): Computed {
  const selectorScope = Math.round(clamp(num(p, "selectorScope", 3), 0, 3));
  const v2Share = clamp(Math.round(num(p, "v2Share", 100)), 0, 100);
  const meshMatch = num(p, "meshMatch", 1) >= 0.5;
  const proxyCompat = num(p, "proxyCompat", 1) >= 0.5;
  const checkoutV2 = Math.round(CHECKOUT * (v2Share / 100));
  const target = Math.round(checkoutV2 * TARGET_SHARE);
  let selectedBase: number;
  if (selectorScope === 0) selectedBase = TOTAL;
  else if (selectorScope === 1) selectedBase = CHECKOUT;
  else if (selectorScope === 2) selectedBase = checkoutV2;
  else selectedBase = target;
  const selected = Math.floor(selectedBase * (meshMatch ? 1 : 0.5));
  const affected = Math.floor(selected * (proxyCompat ? 1 : 0.7));
  const overmatched = Math.max(0, affected - target);
  const missed = Math.max(0, target - affected);
  return {
    selectorScope,
    v2Share,
    meshMatch,
    proxyCompat,
    checkoutV2,
    target,
    selectedBase,
    selected,
    affected,
    overmatched,
    missed,
    missedShare: target > 0 ? (missed / target) * 100 : 0,
  };
}

function selectorLabel(scope: number): string {
  if (scope === 0) return "service: *";
  if (scope === 1) return "service: checkout";
  if (scope === 2) return "service: checkout, version: v2";
  return "service + version + zone: eu";
}

function buildFrame(c: Computed, seed: number): SimFrame {
  const configHealth: SimState =
    c.affected === 0 || c.overmatched >= 6 || c.missed >= 2
      ? "crit"
      : c.overmatched > 0 || c.missed > 0
        ? "warn"
        : "ok";
  const sidecarHealth: SimState =
    c.missed > 0 || c.overmatched >= 6 ? "crit" : c.overmatched > 0 ? "warn" : "ok";
  const syncHealth: SimState = c.overmatched > 0 || c.missed > 0 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "operator",
        label: "Operator",
        kind: "client",
        health: "ok",
        sublabel: "kubectl apply",
        detail: "The operator writes a policy object. The policy is not traffic; it is desired configuration for selected data plane proxies.",
        meta: { view: "flow" },
      },
      {
        id: "control-plane",
        label: "Kuma control plane",
        kind: "mesh",
        health: "ok",
        sublabel: "kuma-cp",
        detail: "Kuma's control plane stores configuration, computes effective policy per data plane proxy, and serves it over xDS.",
        meta: { view: "flow" },
      },
      {
        id: "store",
        label: "Policy store",
        kind: "storage",
        health: syncHealth,
        sublabel: `mesh: ${c.meshMatch ? "matched" : "other mesh"}`,
        detail: "Policies are scoped to a mesh. A policy in one mesh does not apply to data plane proxies in another, even if their labels match.",
        meta: { view: "flow" },
      },
      {
        id: "xds",
        label: "xDS server",
        kind: "mesh",
        health: configHealth,
        sublabel: `${c.affected} proxies configured`,
        detail: `The control plane resolved the selector to ${c.affected} proxies. It pushes listener, route, cluster, and filter configuration to each one.`,
        meta: { view: "flow" },
      },
      {
        id: "sidecar",
        label: "checkout sidecar",
        kind: "mesh",
        health: sidecarHealth,
        sublabel: `selector: ${selectorLabel(c.selectorScope)}`,
        detail: c.overmatched > 0
          ? `The selector matches ${c.affected} proxies, but the intended target is ${c.target}. ${c.overmatched} unrelated workloads receive the policy.`
          : c.missed > 0
            ? `The selector reaches ${c.affected} of ${c.target} intended proxies. ${c.missed} workloads miss the policy because of selector, mesh, or version scope.`
            : "The selector reaches exactly the intended workloads in the same mesh and on a compatible sidecar version.",
        meta: { view: "flow" },
      },
      {
        id: "checkout",
        label: "Checkout service",
        kind: "service",
        health: "ok",
        sublabel: "data plane traffic",
        detail: "The application keeps serving traffic. Whether the policy applies is a control plane decision made before the request arrives.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("operator-cp", "operator", "control-plane", 1, "ok"),
      edge("cp-store", "control-plane", "store", 1, c.meshMatch ? "ok" : "warn"),
      edge("store-xds", "store", "xds", 1, configHealth),
      edge("xds-sidecar", "xds", "sidecar", 1, sidecarHealth),
      edge("sidecar-checkout", "sidecar", "checkout", 1, "ok"),
    ],
    metrics: [
      metric("target-proxies", "Intended target proxies", c.target, "", undefined, undefined, "count"),
      metric("selected-proxies", "Selector matches before version", c.selected, "", undefined, undefined, "count"),
      metric("affected-proxies", "Proxies receiving the policy", c.affected, "", undefined, undefined, "count"),
      metric("overmatched-proxies", "Overmatched proxies", c.overmatched, "", 1, 6, "count"),
      metric("missed-proxies", "Missed proxies", c.missed, "", 1, 2, "count"),
      metric("missed-share", "Missed share", c.missedShare, "%", 10, 40, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: c.overmatched > 0
      ? `${c.affected} proxies receive the policy; ${c.overmatched} are outside the intended ${c.target}.`
      : c.missed > 0
        ? `${c.affected} of ${c.target} intended proxies receive the policy; ${c.missed} miss it.`
        : `${c.affected} proxies receive the policy; selector matches the intended ${c.target}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "overmatched-proxies",
    metricId: "overmatched-proxies",
    warn: 1,
    crit: 6,
    title: "The policy selector matches workloads outside its intended scope",
    cause:
      "The selector is broader than the policy's intent. A wildcard service selector, a missing version tag, or a policy in a shared mesh can apply the policy to data plane proxies that should not receive it.",
    fix:
      "Narrow the selector with the service, version, and zone tags that define the target. Prefer one specific policy per workload group over a broad policy that every team must reason about.",
    checkFirst: [
      "Read the policy's selector and compare it with the labels on a target data plane proxy.",
      "Use the Inspect API to list the proxies affected by the policy.",
      "Check whether the policy is scoped to the mesh you expect.",
    ],
  },
  {
    id: "missed-proxies",
    metricId: "missed-proxies",
    warn: 1,
    crit: 2,
    title: "Intended workloads are not receiving the policy",
    cause:
      "The selector is too narrow, the workload is in another mesh, or the sidecar version does not understand the policy type. A tag mismatch looks identical to a policy that was never applied.",
    fix:
      "Compare the selector with the workload's actual tags, confirm the mesh, and check control plane and sidecar versions. Use `kumactl inspect dataplane` to see the matched policy set.",
    checkFirst: [
      "Check the workload's `kuma.io/service`, version, and zone tags.",
      "Check the policy's mesh and the data plane's mesh.",
      "Check whether the policy type is supported by the sidecar version.",
    ],
  },
  {
    id: "missed-share",
    metricId: "missed-share",
    warn: 10,
    crit: 40,
    title: "A large share of the intended policy scope is uncovered",
    cause:
      "The selector resolves to fewer proxies than intended. The gap is usually a tag that exists on some workloads but not others, or a mesh boundary that splits the population.",
    fix:
      "Make the selector match the labels that actually exist, and move the workloads into the correct mesh if the boundary is wrong. Do not add a second broad policy to cover the gap; that creates precedence conflicts.",
    checkFirst: [
      "Count the target workloads and compare with the affected set.",
      "Check for missing or differently cased tag values.",
      "Check whether a more specific policy of the same type is winning.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const kumaModel: SimModel = {
  id: "mesh-kuma-control-plane",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(compute(defaults()), seed),
  step: (frame, p) => {
    const computed = compute(p);
    const next = buildFrame(computed, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (computed.overmatched > 0 && frame.flags.overSeen !== 1) {
      pushEvent(next, {
        id: "policy-overmatch",
        at: frame.t,
        severity: computed.overmatched >= 6 ? "crit" : "warn",
        title: "Policy selector overmatches workloads",
        detail: `${computed.affected} proxies receive the policy, but the intended target is ${computed.target}. ${computed.overmatched} unrelated workloads are in scope.`,
        nodeId: "sidecar",
        metricId: "overmatched-proxies",
      });
      next.flags.overSeen = 1;
    }
    if (computed.missed > 0 && frame.flags.missedSeen !== 1) {
      pushEvent(next, {
        id: "policy-missed",
        at: frame.t,
        severity: "crit",
        title: "Policy misses intended workloads",
        detail: `${computed.missed} of ${computed.target} intended proxies do not receive the policy. Check selector tags, mesh scope, and sidecar version.`,
        nodeId: "sidecar",
        metricId: "missed-proxies",
      });
      next.flags.missedSeen = 1;
    }
    if (!computed.meshMatch && frame.flags.meshSeen !== 1) {
      pushEvent(next, {
        id: "policy-mesh-miss",
        at: frame.t,
        severity: "crit",
        title: "Policy and workloads are in different meshes",
        detail: "A Kuma policy applies only to data plane proxies in its own mesh. The selector cannot cross the mesh boundary.",
        nodeId: "store",
        metricId: "missed-proxies",
      });
      next.flags.meshSeen = 1;
    }
    if (computed.overmatched === 0 && computed.missed === 0 && (frame.flags.overSeen === 1 || frame.flags.missedSeen === 1) && frame.flags.scopeOkSeen !== 1) {
      pushEvent(next, {
        id: "policy-scope-ok",
        at: frame.t,
        severity: "info",
        title: "Policy scope is now exact",
        detail: `The selector reaches ${computed.affected} proxies, which matches the intended target.`,
        nodeId: "sidecar",
      });
      next.flags.scopeOkSeen = 1;
    }
    next.summary = computed.overmatched > 0
      ? `${computed.affected} proxies receive the policy; ${computed.overmatched} are outside the intended ${computed.target}.`
      : computed.missed > 0
        ? `${computed.affected} of ${computed.target} intended proxies receive the policy; ${computed.missed} miss it.`
        : `${computed.affected} proxies receive the policy; selector matches the intended ${computed.target}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    items.push(`The policy is intended for ${c.target} checkout v2 workloads in eu. The selector resolves to ${c.selected} proxies before version compatibility, and ${c.affected} receive the policy.`);
    if (c.overmatched > 0) items.push(`${c.overmatched} proxies outside the intended target match the selector. A wildcard or missing tag is the usual cause; the policy is not "broken", it is scoped too broadly.`);
    if (c.missed > 0) items.push(`${c.missed} intended proxies do not receive the policy. Check the selector tag values, the mesh boundary, and the sidecar version before changing the policy body.`);
    items.push("Kuma's control plane computes effective policy per data plane proxy. The data plane enforces what the control plane sends; it does not evaluate selectors at request time.");
    items.push("Only one policy of a given type is matched to a particular inbound. When two policies match with equal specificity, the most recently modified one wins.");
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
    description: "The selector matches checkout v2 in eu, in the same mesh, on compatible sidecars. Exactly the intended four proxies receive the policy.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Too broad",
    description: "The selector drops the version tag and matches all checkout workloads. The policy reaches four proxies outside the intended target.",
    tone: "warn",
    params: defaults({ selectorScope: 1, v2Share: 100, meshMatch: 1, proxyCompat: 1 }),
  },
  {
    id: "failure",
    label: "Wildcard",
    description: "The selector uses `kuma.io/service: '*'`. Every data plane in the mesh receives the policy, including payments and v1 workloads.",
    tone: "crit",
    params: defaults({ selectorScope: 0, v2Share: 100, meshMatch: 1, proxyCompat: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The selector is narrowed to checkout v2 in eu. The policy reaches exactly the intended workloads.",
    tone: "ok",
    params: defaults({ selectorScope: 3, v2Share: 100, meshMatch: 1, proxyCompat: 1 }),
  },
];

const experiment: Experiment = {
  id: "kuma-policy-scope",
  title: "Trace a policy to the wrong workloads",
  simId: "kuma",
  question:
    "A retry policy applies to half the mesh, including workloads that should not have it. Where do you look first?",
  prediction: {
    options: [
      { id: "selector", label: "The policy selector and mesh scope: a wildcard or missing tag matches more data plane proxies than intended" },
      { id: "cpu", label: "The sidecar CPU: overloaded proxies apply the policy more aggressively" },
      { id: "readiness", label: "The checkout readiness probe: only Ready pods receive policy" },
      { id: "dns", label: "DNS resolution: the policy is delivered by DNS" },
    ],
    correctOptionId: "selector",
    explanation:
      "Kuma's control plane resolves a policy selector to a set of data plane proxies. If the selector uses a wildcard or omits a tag such as version or zone, it matches every workload that satisfies the remaining tags. The data plane does not re-evaluate the selector per request, and CPU or readiness does not change which proxies the control plane selected.",
  },
  setup: defaults({ selectorScope: 0, v2Share: 100, meshMatch: 1, proxyCompat: 1 }),
  runFor: 8,
  observe: [
    "The selector matches twelve proxies, while the intended target is four.",
    "Eight proxies outside the target receive the policy; payments and v1 workloads are included.",
    "The overmatch metric crosses the critical threshold and the event feed names the selector.",
    "The control plane and xDS nodes stay healthy; the policy is being delivered as configured.",
    "Narrowing the selector to checkout v2 in eu restores the exact scope.",
  ],
  explain:
    "The policy is valid, but its selector is broader than its intent. Kuma matches data plane proxies by tags such as `kuma.io/service`, version, and zone, and scopes the result to the policy's mesh. A wildcard service selector matches every proxy in that mesh. The fix is to make the selector describe the intended workload set, not to change the policy body or restart the sidecars.",
  fix: defaults({ selectorScope: 3, v2Share: 100, meshMatch: 1, proxyCompat: 1 }),
  debrief:
    "With the selector narrowed to checkout v2 in eu, four proxies receive the policy and no unrelated workload does. Overmatch and missed both fall to zero. The Inspect API is the fastest way to confirm the selected set before and after the change, and it also shows which concrete policy won when several of the same type match.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Kuma is a service mesh whose control plane, `kuma-cp`, stores mesh configuration and distributes it to data plane proxies. A data plane proxy is usually a `kuma-dp` sidecar running Envoy next to the workload. The control plane watches policies, computes the effective configuration for each proxy, and serves it over the xDS APIs that Envoy consumes. The data plane enforces the result at request time; it does not evaluate Kuma selectors per request.",
  },
  {
    type: "p",
    text: "A Kuma policy is a declarative object such as a retry, timeout, traffic permission, or HTTP route. Policies are scoped to a mesh. They select data plane proxies by tags such as `kuma.io/service`, version, and zone, or, in newer policy APIs, by a `targetRef` that names a mesh, service, or subset. The selector is the part that decides where a policy applies. The policy body decides what it does once it applies.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The control plane path is operator, API server or `kumactl`, Kuma control plane, policy store, xDS server, data plane proxy. The data plane path is client, sidecar inbound listener, Envoy filters, route, cluster, workload. These paths meet at the proxy: the control plane writes configuration, and the proxy executes it. A policy that applies to the wrong half of the mesh is a control plane selection problem, not a traffic-path problem. The requests themselves never consult the selector.",
  },
  {
    type: "table",
    headers: ["Question", "Kuma object", "Evidence"],
    rows: [
      ["What should happen?", "Policy body", "Policy spec and review"],
      ["Who should it affect?", "Selector or targetRef", "`kumactl inspect dataplane`"],
      ["Which mesh?", "`Mesh` scope", "Policy and data plane mesh fields"],
      ["Did the proxy receive it?", "xDS config", "Envoy config dump"],
      ["Which policy won?", "Effective policy", "Inspect API matched policies"],
    ],
  },
  {
    type: "compare",
    leftTitle: "Control plane",
    rightTitle: "Data plane",
    rows: [
      { label: "Job", left: "Store policy, resolve selectors, compute and push config", right: "Enforce listeners, routes, clusters, and filters" },
      { label: "Failure looks like", left: "Policy missing, overbroad, or stale", right: "Requests rejected, delayed, or routed incorrectly" },
      { label: "First check", left: "Selector, mesh, policy version", right: "Envoy config dump and request logs" },
      { label: "Scales with", left: "Number of policies and proxies", right: "Request rate and connection count" },
    ],
  },
  {
    type: "p",
    text: "Selector specificity matters because Kuma matches one policy of a given type to a particular inbound. The most specific matching policy wins; when two policies match with the same specificity, the most recently modified one wins. That rule is useful for overrides but dangerous when a broad policy is added later: it can silently change behavior for workloads that already had a specific policy. The Inspect API exists to show the resolved set and the winning policy instead of making operators guess.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A flow from operator to control plane, policy store, xDS server, sidecar, and checkout service.",
      "Intended target, selector matches, affected proxies, overmatch, missed, and missed share.",
      "A wildcard selector that applies the policy to every proxy in the mesh.",
      "A narrower selector that reaches exactly the intended checkout v2 workloads in eu.",
      "Events that distinguish overmatch from missed scope and a mesh boundary miss.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Wildcard. Watch the affected count jump from four to twelve and the overmatch metric cross its threshold. Narrow the selector to recover. Then set the mesh or version control to zero to see the opposite failure: intended workloads missing the policy.",
  },
  { type: "sim", simId: "kuma" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The policy body was fine. Its selector used `kuma.io/service: '*'`, so the control plane resolved it to every data plane proxy in the mesh. Twelve proxies received the policy, including payments and checkout v1 workloads, while the intended target was four checkout v2 proxies in eu. The control plane and xDS path were healthy; they delivered exactly the configuration they were given.",
  },
  {
    type: "p",
    text: "Narrowing the selector to service, version, and zone reduced the affected set to the intended four and cleared both overmatch and missed. When the mesh or sidecar-version controls are wrong, the opposite happens: the selector looks correct but some or all intended proxies never receive the policy. The affected count is the bridge between the two symptoms.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`kumactl inspect dataplane NAME` lists the policies matched to each attachment point.",
      "`kumactl inspect POLICY_KIND NAME` lists the data plane proxies affected by a policy.",
      "The Inspect API's config dump shows the Envoy configuration the proxy received.",
      "Policy and data plane mesh fields show whether a mesh boundary is blocking the match.",
      "Control plane and sidecar versions show whether a policy type is understood by the proxy.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the selector, then the workload's actual tags, then the mesh, then the policy and proxy versions. The Inspect API answers the first three faster than reading YAML by hand.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "List the intended target workloads and their actual tags before editing the selector.",
      "Narrow the selector to the service, version, and zone that define that target.",
      "Confirm the policy and the workloads are in the same mesh.",
      "Confirm the sidecar version understands the policy type.",
      "Check for another policy of the same type that wins by specificity or modification time.",
      "Verify the affected set with the Inspect API and the proxy config dump after the change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A broad selector reduces the number of policy objects but makes every change a fleet-wide change.",
      "A narrow selector is safer to review but multiplies objects and can miss a new workload that lacks the expected tag.",
      "Tag-based selectors are flexible but depend on consistent labels; a missing tag silently changes the match.",
      "Newer targetRef policies are more explicit but require sidecars and control plane versions that support them.",
      "One policy per type keeps precedence simple; stacking policies for the same type makes the winner hard to predict.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "control-vs-data",
    question:
      "Explain the difference between Kuma's control plane and data plane, and where you would look for a policy that is not taking effect.",
    difficulty: 2,
    hints: [
      "One decides configuration; the other enforces it.",
      "A selector is resolved before the request.",
    ],
    answer:
      "The control plane stores policy and mesh configuration, resolves selectors to data plane proxies, computes effective config, and pushes it over xDS. The data plane is the sidecar and Envoy, which enforce listeners, routes, clusters, and filters at request time. If a policy is not taking effect, I would first check whether the control plane selected the workload: selector tags, mesh scope, and policy or proxy version. Then I would check the Inspect API and the proxy's config dump to see whether the effective config arrived. Only after that would I look at request-path behavior, because the data plane does not evaluate Kuma selectors itself.",
    followUps: [
      "Which API shows matched policies for one proxy?",
      "What does a stale config dump tell you?",
      "How would a mesh boundary change the answer?",
    ],
    redFlags: [
      "Debugs the application first.",
      "Assumes the sidecar evaluates selectors.",
      "Ignores policy version.",
    ],
    rubric: [
      "Separates configuration from enforcement.",
      "Names selector and mesh scope.",
      "Uses the Inspect API.",
      "Checks the config dump.",
    ],
  },
  {
    id: "selector-debug",
    question:
      "A policy applies to half the mesh and no one knows why. What is your debugging sequence?",
    difficulty: 3,
    hints: [
      "Start from the intended target.",
      "Compare tags, mesh, and version.",
    ],
    answer:
      "I would write down the intended workload set, then inspect the policy's selector and the actual tags on those workloads. I would check whether the selector uses a wildcard, omits a version or zone tag, or matches a shared service name. Then I would confirm the policy and workloads are in the same mesh, and that the sidecar version supports the policy type. The Inspect API gives both directions: matched policies for a data plane, and affected data planes for a policy. If several policies of the same type match, I would check specificity and modification time to see which one wins.",
    followUps: [
      "What would make a selector match exactly half the workloads?",
      "How do you find the winning policy?",
      "What would you change first?",
    ],
    redFlags: [
      "Edits the policy body before the selector.",
      "Restarts sidecars.",
      "Ignores mesh scope.",
    ],
    rubric: [
      "Starts from intended target.",
      "Checks tags, mesh, and version.",
      "Uses both Inspect API directions.",
      "Explains policy precedence.",
    ],
  },
  {
    id: "precedence",
    question:
      "Two policies of the same type match the same workload. Which one applies, and how would you make the outcome predictable?",
    difficulty: 3,
    hints: [
      "Specificity comes before recency.",
      "Only one policy of a type is matched per inbound.",
    ],
    answer:
      "Kuma matches one policy of a given type to a particular inbound. The more specific selector wins; if two policies have equal specificity, the most recently modified one wins. That makes a broad policy added later able to override a specific one, which is hard to review. I would make the outcome predictable by giving each workload group exactly one owner and one policy per type, using explicit tags, and checking the Inspect API's matched-policy view after every change. If overrides are truly needed, I would encode them in the selector rather than rely on modification time.",
    followUps: [
      "How is specificity calculated?",
      "Why is modification time a risky tiebreaker?",
      "How would you audit for overlapping policies?",
    ],
    redFlags: [
      "Assumes the newest always wins.",
      "Stacks policies for the same type.",
      "Ignores the inbound attachment point.",
    ],
    rubric: [
      "States specificity first.",
      "Mentions modification time as tiebreaker.",
      "Explains one-policy-per-type.",
      "Proposes explicit ownership.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every policy has an owner and a documented intended workload set.",
      "Selectors use explicit service, version, and zone tags instead of wildcards.",
      "Mesh boundaries and policy API versions are part of the review.",
      "The Inspect API is available to responders, not only to the platform team.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "List the intended target and compare it with the policy's affected set.",
      "Check the workload's actual tags, not the tags you expect it to have.",
      "Confirm the policy and workloads share a mesh.",
      "Check whether the sidecar version supports the policy type.",
      "Look for a more specific policy of the same type that may be winning.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a test that asserts the affected set for each shared policy.",
      "Remove wildcard selectors from policies that are meant for one service.",
      "Document the precedence rule and the owner for each policy type.",
      "Alert when a policy's affected set changes after a label or mesh change.",
    ],
  },
];

const references = [
  {
    title: "Kuma policies overview",
    url: "https://kuma.io/docs/latest/policies/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Policy families, mesh scoping, and how policies configure data plane proxies.",
  },
  {
    title: "How Kuma chooses the right policy to apply",
    url: "https://kuma.io/docs/latest/policies/how-kuma-chooses-the-right-policy-to-apply/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Selector matching, specificity, and the one-policy-per-type rule.",
  },
  {
    title: "Kuma Inspect API",
    url: "https://kuma.io/docs/latest/explore/inspect-api/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Matched policies per data plane, affected proxies per policy, and Envoy config dumps.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    kuma: {
      model: kumaModel,
      presets,
      instructions:
        "Start Healthy, apply Wildcard, then narrow the selector. Use the mesh and version controls to see intended workloads miss the policy instead of unrelated workloads receiving it.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The workload counts, tag shares, and version-compatibility percentage are teaching values, not Kuma defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "mesh-envoy-clusters",
    "mesh-policy-conflict",
    "mesh-mtls",
    "mesh-retries",
    "mesh-timeouts",
  ],
};
