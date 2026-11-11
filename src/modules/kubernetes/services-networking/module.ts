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
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const POD_CAPACITY = 1_200;

const params: ParamSpec[] = [
  {
    id: "replicas",
    label: "Pod replicas",
    min: 2,
    max: 10,
    step: 1,
    value: 6,
    unit: " pods",
    group: "Workload",
    help: "Pods in the workload. The Service does not own these pods; it selects them by label.",
    format: "count",
  },
  {
    id: "readyPercent",
    label: "Pods passing readiness",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Workload",
    help: "Share of pods that pass their readiness probe. Only Ready pods become Service endpoints unless the Service explicitly publishes not-ready addresses.",
    format: "percent",
  },
  {
    id: "selectorMatch",
    label: "Selector match",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Service",
    help: "1 means the Service selector matches the pod labels. 0 means it does not. A selector in another namespace or with one wrong label selects nothing.",
    format: "count",
  },
  {
    id: "requestRate",
    label: "Client request rate",
    min: 1_000,
    max: 20_000,
    step: 1_000,
    value: 5_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second sent to the ClusterIP. Each Ready endpoint is modeled at 1,200 rps of illustrative capacity.",
    format: "rps",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Values {
  replicas: number;
  readyPods: number;
  notReady: number;
  endpoints: number;
  selectorMatch: number;
  requestRate: number;
  capacity: number;
  routed: number;
  dropped: number;
  errorRate: number;
  gap: number;
}

function compute(p: Params): Values {
  const replicas = Math.round(clamp(num(p, "replicas", 6), 2, 10));
  const readyPercent = clamp(num(p, "readyPercent", 100), 0, 100);
  const selectorMatch = Math.round(clamp(num(p, "selectorMatch", 1), 0, 1));
  const requestRate = Math.max(1, num(p, "requestRate", 5_000));
  const readyPods = Math.round((replicas * readyPercent) / 100);
  const notReady = Math.max(0, replicas - readyPods);
  const endpoints = selectorMatch === 1 ? readyPods : 0;
  const capacity = endpoints * POD_CAPACITY;
  const routed = Math.min(requestRate, capacity);
  const dropped = Math.max(0, requestRate - capacity);
  const errorRate = requestRate > 0 ? (dropped / requestRate) * 100 : 0;
  const gap = replicas > 0 ? ((replicas - endpoints) / replicas) * 100 : 0;
  return {
    replicas,
    readyPods,
    notReady,
    endpoints,
    selectorMatch,
    requestRate,
    capacity,
    routed,
    dropped,
    errorRate,
    gap,
  };
}

function gapHealth(gap: number): Health {
  if (gap >= 50) return "crit";
  if (gap >= 10) return "warn";
  return "ok";
}

function errorHealth(errorRate: number): Health {
  if (errorRate >= 5) return "crit";
  if (errorRate >= 1) return "warn";
  return "ok";
}

function buildFrame(values: Values, seed: number): SimFrame {
  const endpoints = values.endpoints > 0 ? gapHealth(values.gap) : ("down" as const);
  const service = values.endpoints > 0 ? gapHealth(values.gap) : ("down" as const);
  const proxy: Health = values.endpoints > 0 ? "ok" : "crit";
  const client = errorHealth(values.errorRate);
  const ready: Health =
    values.readyPods === 0
      ? "crit"
      : values.selectorMatch === 1
        ? values.endpoints < values.readyPods
          ? "warn"
          : "ok"
        : "warn";
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: client,
        utilization: clamp(values.routed / values.requestRate),
        throughput: values.routed,
        sublabel: `${Math.round(values.routed).toLocaleString()} rps routed`,
        detail: `Clients call the stable ClusterIP, not a pod IP. ${Math.round(values.dropped).toLocaleString()} rps have no Ready endpoint in this snapshot.`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Service: web",
        kind: "service",
        health: service,
        utilization: clamp(values.endpoints / values.replicas),
        sublabel:
          values.selectorMatch === 1 ? `${values.endpoints} endpoints` : "selector matches nothing",
        detail:
          values.selectorMatch === 1
            ? "The Service selector matches pods in this namespace. EndpointSlice membership is built from the matching Ready pods."
            : "The Service exists and has a ClusterIP, but its label selector matches no pods. A Service without matching Ready pods has no usable endpoints.",
        meta: { view: "flow" },
      },
      {
        id: "proxy",
        label: "kube-proxy rules",
        kind: "mesh",
        health: proxy,
        utilization: clamp(values.endpoints / Math.max(1, values.replicas)),
        sublabel: values.endpoints > 0 ? "programmed with endpoints" : "no backend to program",
        detail:
          "kube-proxy programs the node data plane for the ClusterIP. It does not create endpoints; it forwards to the addresses the EndpointSlice controller publishes.",
        meta: { view: "flow" },
      },
      {
        id: "endpoints",
        label: "EndpointSlice",
        kind: "service",
        health: endpoints,
        utilization: clamp(values.endpoints / Math.max(1, values.replicas)),
        sublabel: `${values.endpoints} ready addresses`,
        detail: `Endpoint addresses come from Ready pods selected by the Service. ${values.notReady} pods are not Ready and are excluded in this model.`,
        meta: { view: "flow" },
      },
      {
        id: "ready-pods",
        label: "Selected Ready pods",
        kind: "service",
        health: ready,
        utilization: clamp(values.endpoints / Math.max(1, values.readyPods)),
        sublabel:
          values.selectorMatch === 1
            ? `${values.endpoints}/${values.readyPods} selected`
            : `${values.readyPods} Ready, not selected`,
        detail:
          values.selectorMatch === 1
            ? `${values.endpoints} of ${values.readyPods} Ready pods are endpoints. A Ready pod that matches the selector receives traffic from this Service.`
            : `The pods are Ready, but their labels do not match the Service selector. Readiness cannot help a Service that selects nothing.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge(
        "client-service",
        "client",
        "service",
        clamp(values.routed / values.requestRate),
        client,
        "ClusterIP",
      ),
      edge(
        "service-proxy",
        "service",
        "proxy",
        clamp(values.endpoints / Math.max(1, values.replicas)),
        service,
        "rules",
      ),
      edge(
        "proxy-endpoints",
        "proxy",
        "endpoints",
        clamp(values.endpoints / Math.max(1, values.replicas)),
        proxy,
        "forward",
      ),
      edge(
        "endpoints-ready",
        "endpoints",
        "ready-pods",
        clamp(values.endpoints / Math.max(1, values.replicas)),
        endpoints,
        "ready only",
      ),
    ],
    metrics: [
      metric(
        "endpoints",
        "Ready endpoints",
        values.endpoints,
        " endpoints",
        undefined,
        undefined,
        "count",
      ),
      metric("endpoint-gap", "Endpoint gap", values.gap, "%", 10, 50, "percent"),
      metric("service-error-rate", "Service error rate", values.errorRate, "%", 1, 5, "percent"),
      metric(
        "dropped-requests",
        "Dropped requests",
        values.dropped,
        " rps",
        undefined,
        undefined,
        "rps",
      ),
      metric(
        "service-capacity",
        "Ready endpoint capacity",
        values.capacity,
        " rps",
        undefined,
        undefined,
        "rps",
      ),
      metric("ready-pods", "Ready pods", values.readyPods, " pods", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, endpoints: values.endpoints, gap: values.gap, errors: values.errorRate },
    summary: `${values.endpoints} ready endpoints for ${values.replicas} pods. ${values.errorRate.toFixed(1)}% of ${Math.round(values.requestRate).toLocaleString()} rps fail.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = 0.015 * Math.sin((index + (seed % 7)) / 3.4);
      return Math.max(0, item.value * (1 + wave));
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "endpoint-gap",
    metricId: "endpoint-gap",
    warn: 10,
    crit: 50,
    title: "The Service has fewer endpoints than pods",
    cause:
      "The Service selector matches no pods, or matching pods are not Ready. A Service only publishes addresses for pods that match its labels and pass readiness. A selector in the wrong namespace or with one misspelled label selects nothing.",
    fix: "Compare the Service selector with the pod labels, then check pod readiness. If the selector is wrong, correct it; if readiness is failing, fix the probe or the application. Do not add pod IPs to the Service definition.",
    checkFirst: [
      "Run kubectl get endpointslices and kubectl describe service to compare selector labels.",
      "Check pod labels and namespace against the Service selector.",
      "Check Ready condition and readiness probe results on the pods you expect to match.",
    ],
  },
  {
    id: "service-error-rate",
    metricId: "service-error-rate",
    warn: 1,
    crit: 5,
    title: "Requests to the Service are failing",
    cause:
      "The ClusterIP has no usable endpoint, or the Ready endpoints cannot carry the offered load. Traffic is dropped or refused before it reaches a pod; application logs may show no request at all.",
    fix: "Restore endpoint membership first. If endpoints exist but capacity is short, add Ready pods or reduce traffic. Check kube-proxy and the node data plane only after endpoint membership is confirmed.",
    checkFirst: [
      "Check whether the error is connection refused, timeout, or an application response.",
      "Compare Service endpoint count with the request rate.",
      "Check that the client uses the Service DNS name or ClusterIP, not a stale pod IP.",
    ],
  },
];

export const servicesNetworkingModel: SimModel = {
  id: "services-networking",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(compute(defaults()), seed);
    seedSeries(frame);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 1));
    next.t = frame.t;
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, points]) => [key, [...points]]),
    );
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `${values.endpoints} of ${values.replicas} pods are endpoints. The Service selector and pod readiness both have to agree before an address is published.`,
      `Each endpoint is modeled at ${POD_CAPACITY.toLocaleString()} rps. At ${Math.round(values.requestRate).toLocaleString()} rps of demand, the endpoint capacity is ${Math.round(values.capacity).toLocaleString()} rps.`,
    ];
    if (values.selectorMatch === 0) {
      items.push(
        `All ${values.readyPods} Ready pods are invisible to this Service because the selector matches nothing. Readiness is not the problem; label selection is.`,
      );
    } else if (values.notReady > 0) {
      items.push(
        `${values.notReady} pods do not pass readiness and are excluded from the EndpointSlice. They may be running and logging normally while receiving no Service traffic.`,
      );
    } else {
      items.push(
        "Every pod is Ready and selected. If requests still fail, the problem is downstream of endpoint membership: port mapping, network policy, or the application itself.",
      );
    }
    items.push(
      "A ClusterIP is a virtual address, not an interface on a pod. kube-proxy programs forwarding rules on each node; the Service object alone does not move packets.",
    );
    return items;
  },
  legend: [
    { label: "Endpoint ready", tone: "ok" },
    { label: "Partially ready", tone: "warn" },
    { label: "No endpoints", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description:
      "Six Ready pods match the selector. All six are endpoints and demand fits their capacity.",
    tone: "ok",
    params: defaults({ replicas: 6, readyPercent: 100, selectorMatch: 1, requestRate: 5_000 }),
  },
  {
    id: "peak",
    label: "Two pods not Ready",
    description:
      "Four of six pods pass readiness. Endpoint capacity is 4,800 rps against 5,000 rps of demand.",
    tone: "warn",
    params: defaults({ replicas: 6, readyPercent: 67, selectorMatch: 1, requestRate: 5_000 }),
  },
  {
    id: "failure",
    label: "Selector mismatch",
    description:
      "All six pods are Ready, but the Service selector matches none of them. The ClusterIP has no endpoints.",
    tone: "crit",
    params: defaults({ replicas: 6, readyPercent: 100, selectorMatch: 0, requestRate: 5_000 }),
  },
  {
    id: "readiness-gap",
    label: "Readiness gap",
    description:
      "The selector matches, but only half the pods pass readiness. Three endpoints carry 5,000 rps.",
    tone: "crit",
    params: defaults({ replicas: 6, readyPercent: 50, selectorMatch: 1, requestRate: 5_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Eight Ready pods match the selector. Endpoint capacity is well above demand.",
    tone: "ok",
    params: defaults({ replicas: 8, readyPercent: 100, selectorMatch: 1, requestRate: 5_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-no-endpoints",
  title: "Predict why a Service has no endpoints",
  simId: "services-networking",
  question:
    "A Service returns connection failures. Six pods are Running and all six report Ready. The Service has zero endpoints. What is the most likely cause?",
  prediction: {
    options: [
      { id: "selector", label: "The Service selector does not match the pod labels" },
      { id: "readiness", label: "The pods fail their readiness probes" },
      { id: "proxy", label: "kube-proxy is not running on the client node" },
      { id: "dns", label: "The ClusterIP has no DNS record" },
    ],
    correctOptionId: "selector",
    explanation:
      "EndpointSlice membership requires two conditions: the pod must match the Service selector, and the pod must be Ready. The scenario says the pods are Ready, so the missing condition is label selection. A Service object can exist with a valid ClusterIP and still publish no addresses.",
  },
  setup: defaults({ replicas: 6, readyPercent: 100, selectorMatch: 0, requestRate: 5_000 }),
  runFor: 20,
  observe: [
    "Endpoint gap is 100% and the Service reports zero ready endpoints.",
    "All six pods remain Ready; readiness is not the missing condition.",
    "Every request to the ClusterIP fails before reaching a pod.",
    "Correcting the selector publishes the six Ready pod addresses without restarting them.",
  ],
  explain:
    "A Service is a selector plus a virtual address. The EndpointSlice controller watches pods, filters by the Service selector, and publishes addresses only for matching pods that are Ready. If the selector matches nothing, the controller has nothing to publish. kube-proxy then has no backend to program, so the ClusterIP drops or refuses traffic even though the application is healthy.",
  fix: defaults({ replicas: 6, readyPercent: 100, selectorMatch: 1, requestRate: 5_000 }),
  debrief:
    "Fixing the selector restored endpoint membership without touching the pods. The lesson is the order of checks: Service selector, pod labels, pod readiness, endpoint addresses, then node data plane. Jumping to kube-proxy or DNS before confirming endpoints sends you below the layer that is actually broken.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Kubernetes Service gives a set of pods a stable virtual address and a stable DNS name. The Service does not own the pods. It selects them with a label selector, and a controller publishes the selected Ready pod addresses as EndpointSlice objects. Clients connect to the Service's ClusterIP or DNS name instead of a pod IP that changes when a pod is replaced.",
  },
  {
    type: "p",
    text: "The selector is a label query evaluated in the Service's namespace. If no pod matches, the Service still exists and still has a ClusterIP, but it has no endpoints. Readiness is the second filter: a matching pod that is not Ready is normally excluded, so it receives no Service traffic. A Service can be correctly configured and still have no endpoints because the pods are not Ready, or have endpoints and still fail because the port or network path is wrong.",
  },
  {
    type: "table",
    headers: ["Piece", "What it does", "What it does not do"],
    rows: [
      [
        "Service",
        "Defines a stable virtual IP, DNS name, ports, and selector",
        "Own, schedule, or restart pods",
      ],
      [
        "Selector",
        "Chooses pods by labels in the same namespace",
        "Match a pod with different labels or another namespace",
      ],
      [
        "EndpointSlice",
        "Publishes selected Ready pod addresses and ports",
        "Include not-ready pods by default",
      ],
      [
        "kube-proxy",
        "Programs node forwarding rules for the ClusterIP",
        "Create endpoints or fix a selector",
      ],
    ],
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "A client resolves the Service name through cluster DNS to the ClusterIP, then sends traffic to that virtual address. On the node, kube-proxy has programmed rules that choose a backend endpoint and forward the packet. The packet reaches a pod only if the EndpointSlice contains that pod's address and the port mapping is correct. The Service object is configuration; the data plane is the set of node rules and endpoint addresses.",
  },
  {
    type: "p",
    text: "This module models one Service, its selector, and the readiness of the pods behind it. Endpoint capacity of 1,200 rps per pod is illustrative. The important split is between selection and readiness: a selector mismatch hides healthy pods, while a readiness failure hides running pods. Both produce zero or too few endpoints, but the fix is different.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Ready endpoints: the number of addresses published for the Service.",
      "Endpoint gap: missing endpoints as a share of the pod count.",
      "Service error rate and dropped requests: the client impact of a missing backend.",
      "Selected Ready pods: pods that are Ready but may not match the selector.",
      "kube-proxy and EndpointSlice node states: where the data path has no backend.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Two pods not Ready to see a capacity warning. Apply Selector mismatch and compare the Ready pod count with the endpoint count. Apply Readiness gap to see the other way endpoints disappear. Run the experiment before revealing the explanation, then apply Recovery.",
  },
  {
    type: "p",
    text: "The diagnostic order matters. Check endpoints before checking kube-proxy. A Service with zero endpoints cannot be fixed by restarting the proxy, and a Service with endpoints can still fail because of a port, NetworkPolicy, or application problem. Each layer has a different signal.",
  },
  { type: "sim", simId: "services-networking" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The selector-mismatch preset left six Ready pods running and published zero endpoints. The Service and kube-proxy had no backend, so every request to the ClusterIP failed before an application log line was written. The readiness-gap preset produced a different path to the same symptom: the selector matched, but only three pods were Ready, so three addresses were published and demand exceeded their capacity.",
  },
  {
    type: "p",
    text: "The recovery preset added two more Ready pods and restored endpoint membership. Endpoint capacity rose above demand, so the Service error rate returned to zero. In both failure cases the pods themselves were healthy enough to run; the break was in selection or readiness, not in the container process.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Service endpoints or EndpointSlice addresses, with ready and not-ready conditions.",
      "Service selector and pod labels, including namespace.",
      "Pod Ready condition and readiness probe failures.",
      "kube-proxy or CNI errors only after endpoint membership is confirmed.",
      "Client error type: connection refused, timeout, or an application response.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Run kubectl get endpointslices and kubectl describe service. Compare the Service selector with the pod labels before checking readiness. If endpoints exist, compare their count and port with the request rate, then check the Service targetPort against the container port.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the Service selector matches pod labels in the same namespace.",
      "Confirm the pods you expect are Ready and appear in the EndpointSlice.",
      "Check the Service port and targetPort against the container port.",
      "Check NetworkPolicy and CNI behavior only after endpoints are present.",
      "Add Ready replicas if endpoint capacity is below demand.",
      "Verify client traffic uses the Service DNS name or ClusterIP, not a stale pod IP.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A broad selector is convenient and can include pods from another workload by accident.",
      "Publishing not-ready addresses keeps connections during startup and can send traffic to an app that cannot serve.",
      "A ClusterIP hides pod churn and adds a virtual hop that is harder to trace than a direct pod IP.",
      "Headless Services expose pod DNS for stateful discovery and remove the stable virtual IP.",
      "Readiness probes that check dependencies protect users and can empty a Service during a dependency outage.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "no-endpoints",
    question: "Pods are Running and Ready, but the Service has no endpoints. How do you debug it?",
    difficulty: 2,
    hints: [
      "A Service selector is evaluated against labels in the same namespace.",
      "Ready pods can still be invisible if the selector is wrong.",
    ],
    answer:
      "I would compare the Service selector with the pod labels first, including the namespace. Then I would check the EndpointSlice to see whether any addresses are published and whether the pods are listed as ready. If the selector matches and the pods are Ready, I would check the Service port and targetPort, then NetworkPolicy and the node data plane. I would not restart kube-proxy before confirming endpoint membership, because a selector mismatch produces zero endpoints regardless of the proxy.",
    followUps: [
      "How would you tell a selector mismatch from a readiness failure?",
      "What changes if the Service is headless?",
      "How would you test the fix without changing the client?",
    ],
    redFlags: [
      "Restarts kube-proxy first.",
      "Assumes Ready means selected.",
      "Ignores namespace in the selector.",
    ],
    rubric: [
      "Checks selector and labels.",
      "Checks EndpointSlice membership.",
      "Separates readiness from selection.",
      "Checks port and network after endpoints.",
    ],
  },
  {
    id: "clusterip-path",
    question:
      "Explain what happens between a client calling a Service DNS name and a request reaching a pod.",
    difficulty: 2,
    hints: [
      "The ClusterIP is virtual and does not belong to a pod.",
      "kube-proxy programs rules; the EndpointSlice supplies addresses.",
    ],
    answer:
      "The client resolves the Service name through cluster DNS to the ClusterIP. The packet goes to that virtual address and is intercepted on the node by rules that kube-proxy programmed. Those rules select a backend from the Service's endpoints and forward or translate the packet to a pod address and port. The pod must be selected by the Service and Ready to be in the EndpointSlice. If the Service is headless, DNS returns pod addresses directly and there is no ClusterIP virtual hop.",
    followUps: [
      "Why can you not ping a ClusterIP?",
      "What does a headless Service change?",
      "Where would you look for a port mismatch?",
    ],
    redFlags: [
      "Says the ClusterIP is assigned to a pod.",
      "Treats the Service object as the data plane.",
      "Forgets that endpoints come from readiness.",
    ],
    rubric: [
      "Describes DNS to ClusterIP.",
      "Describes kube-proxy forwarding.",
      "Connects endpoints to pod readiness.",
      "Distinguishes headless behavior.",
    ],
  },
  {
    id: "service-capacity",
    question:
      "A Service has all expected endpoints, but p99 is rising and some requests fail. What do you check next?",
    difficulty: 3,
    hints: [
      "Endpoint count is not capacity.",
      "The port can be open while the application is saturated.",
    ],
    answer:
      "I would compare the request rate with the capacity of the Ready endpoints and check whether the pod count is below the desired replicas. Then I would look at per-pod CPU, latency, and error rate, plus the Service port and targetPort. If endpoints are healthy but saturated, the fix is capacity or load reduction, not selector changes. I would also check whether a recent rollout reduced Ready pods or changed the container port.",
    followUps: [
      "How would a readiness probe passing but an application failing show up?",
      "What would a targetPort mismatch look like from the client?",
      "When would you scale the Deployment instead of the Service?",
    ],
    redFlags: [
      "Assumes endpoints guarantee capacity.",
      "Changes the selector without evidence.",
      "Ignores per-pod saturation.",
    ],
    rubric: [
      "Separates membership from capacity.",
      "Checks per-pod signals.",
      "Verifies port mapping.",
      "Chooses a capacity or rollout fix.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Service selectors are specific enough to avoid selecting another workload.",
      "Readiness probes reflect the ability to serve traffic.",
      "Service ports and targetPorts match the container ports.",
      "EndpointSlice membership is monitored alongside pod readiness.",
      "Clients use Service DNS names, not cached pod IPs.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare Service selector with pod labels and namespace.",
      "Check EndpointSlice ready addresses before checking kube-proxy.",
      "Compare endpoint capacity with request rate.",
      "Check client error type and whether application logs show the request.",
      "Check for a recent rollout or label change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Correct the selector, readiness, or port mapping that broke membership.",
      "Verify endpoints and error rate return to baseline.",
      "Add a test that catches selector drift before deployment.",
      "Document the Service-to-workload ownership boundary.",
    ],
  },
];

const references = [
  {
    title: "Services",
    url: "https://kubernetes.io/docs/concepts/services-networking/service/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Service types, selectors, ClusterIP, endpoints, and headless Services.",
  },
  {
    title: "EndpointSlices",
    url: "https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "How selected pod addresses and readiness become Service endpoints.",
  },
  {
    title: "kube-proxy",
    url: "https://kubernetes.io/docs/reference/command-line-tools-reference/kube-proxy/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "The node component that implements Service virtual IPs and forwarding.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "services-networking": {
      model: servicesNetworkingModel,
      presets,
      instructions:
        "Start Healthy, then apply Two pods not Ready and Readiness gap to see capacity loss. Apply Selector mismatch and compare Ready pods with endpoints. Run the experiment before revealing the explanation, then apply Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 1,200 rps per endpoint and request volumes are teaching values; selector, readiness, and endpoint behavior follow the Kubernetes Service documentation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "kubernetes-pods-deployments",
    "kubernetes-ingress",
    "kubernetes-dns",
    "containers-service-discovery",
  ],
};
