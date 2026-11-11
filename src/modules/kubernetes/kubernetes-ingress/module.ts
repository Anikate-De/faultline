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

const DEMAND_RPS = 10_000;

const params: ParamSpec[] = [
  {
    id: "hostCoverage",
    label: "Host rule coverage",
    min: 0,
    max: 100,
    step: 1,
    value: 100,
    unit: "%",
    group: "Rules",
    help: "Share of requests whose Host matches a rule in this Ingress. A request with an unmatched Host reaches the controller but has no route.",
    format: "percent",
  },
  {
    id: "pathCoverage",
    label: "Path rule coverage",
    min: 0,
    max: 100,
    step: 1,
    value: 100,
    unit: "%",
    group: "Rules",
    help: "Share of host-matched requests whose path matches a rule. pathType Exact and Prefix change which paths match.",
    format: "percent",
  },
  {
    id: "classMatch",
    label: "Ingress class handled",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Controller",
    help: "1 means a controller is watching this Ingress class. 0 means no controller reconciles the object, so its rules never reach a data plane.",
    format: "count",
  },
  {
    id: "servicePortMatch",
    label: "Backend port serves",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Backend",
    help: "1 means the Service port named by the Ingress reaches a serving container port. 0 means the rule matches but the backend has no usable endpoint on that port.",
    format: "count",
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
  hostCoverage: number;
  pathCoverage: number;
  classMatch: number;
  portMatch: number;
  controllerMissing: boolean;
  routedShare: number;
  notFoundShare: number;
  unavailableShare: number;
  routed: number;
  notFound: number;
  unavailable: number;
  notFoundRate: number;
  unavailableRate: number;
}

function compute(p: Params): Values {
  const hostCoverage = clamp(num(p, "hostCoverage", 100), 0, 100);
  const pathCoverage = clamp(num(p, "pathCoverage", 100), 0, 100);
  const classMatch = Math.round(clamp(num(p, "classMatch", 1), 0, 1));
  const portMatch = Math.round(clamp(num(p, "servicePortMatch", 1), 0, 1));
  const controllerMissing = classMatch === 0;
  const hostMatched = controllerMissing ? 0 : hostCoverage / 100;
  const hostAndPath = hostMatched * (pathCoverage / 100);
  const routedShare = controllerMissing || portMatch === 0 ? 0 : hostAndPath;
  const unavailableShare = controllerMissing ? 0 : portMatch === 1 ? 0 : hostAndPath;
  const notFoundShare = controllerMissing ? 0 : Math.max(0, 1 - hostAndPath);
  return {
    hostCoverage,
    pathCoverage,
    classMatch,
    portMatch,
    controllerMissing,
    routedShare,
    notFoundShare,
    unavailableShare,
    routed: DEMAND_RPS * routedShare,
    notFound: DEMAND_RPS * notFoundShare,
    unavailable: DEMAND_RPS * unavailableShare,
    notFoundRate: notFoundShare * 100,
    unavailableRate: unavailableShare * 100,
  };
}

function rateHealth(rate: number): Health {
  if (rate >= 5) return "crit";
  if (rate > 0) return "warn";
  return "ok";
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function buildFrame(values: Values, seed: number): SimFrame {
  const notFound = rateHealth(values.notFoundRate);
  const unavailable = rateHealth(values.unavailableRate);
  const client = values.controllerMissing ? "crit" : worst(notFound, unavailable);
  const controller: Health = values.classMatch === 1 ? "ok" : "down";
  const rule: Health = values.controllerMissing
    ? "down"
    : values.notFoundRate >= 5
      ? "crit"
      : values.notFoundRate > 0
        ? "warn"
        : "ok";
  const service: Health = values.controllerMissing
    ? "warn"
    : values.portMatch === 0
      ? "crit"
      : "ok";
  const pod: Health = values.controllerMissing || values.portMatch === 0 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "External client",
        kind: "client",
        health: client,
        utilization: clamp(values.routedShare + values.unavailableShare),
        throughput: values.routed,
        sublabel: values.controllerMissing
          ? "no route: Ingress class unhandled"
          : `${Math.round(values.routed).toLocaleString()} rps routed · ${Math.round(values.notFoundRate)}% 404`,
        detail: values.controllerMissing
          ? "No controller is watching the Ingress class, so no listener or HTTP route is programmed. Clients fail before HTTP; 404 and 503 rates stay at zero."
          : "Clients call an external hostname. The controller answers 404 when no rule matches and 503 when a rule matches but the backend cannot serve.",
        meta: { view: "flow" },
      },
      {
        id: "controller",
        label: "Ingress controller",
        kind: "lb",
        health: controller,
        utilization: clamp(values.controllerMissing ? 0 : values.hostCoverage / 100),
        sublabel:
          values.classMatch === 1 ? "watching Ingress class" : "no controller for this class",
        detail:
          values.classMatch === 1
            ? "The controller watches Ingress objects with its class, validates rules, and programs its data plane. The object alone does nothing."
            : "The Ingress object is stored, but no controller reconciles it. No listener, rule, or backend is programmed for this hostname.",
        meta: { view: "flow" },
      },
      {
        id: "rules",
        label: "Ingress rules",
        kind: "service",
        health: rule,
        utilization: clamp(
          values.controllerMissing ? 0 : (values.hostCoverage / 100) * (values.pathCoverage / 100),
        ),
        sublabel: values.controllerMissing
          ? "not reconciled"
          : `${Math.round(values.hostCoverage)}% host · ${Math.round(values.pathCoverage)}% path`,
        detail: values.controllerMissing
          ? "The rules never become listeners or routes because no controller has reconciled this object. There is no HTTP handler to return 404 or 503."
          : "Host and path rules are matched in order. A host or path with no rule falls through to the default backend, which commonly returns 404.",
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Service backend",
        kind: "service",
        health: service,
        utilization: clamp(values.routedShare),
        sublabel: values.portMatch === 1 ? "port 80 reaches the pod" : "port does not serve",
        detail: values.controllerMissing
          ? "The Service may be healthy, but no Ingress route reaches it. Fix the controller or class before checking the backend."
          : values.portMatch === 1
            ? "The matched rule names a Service and port. The Service must have a Ready endpoint on that port before the controller can forward the request."
            : "The rule names a Service port that no container serves. The controller can match the route and still return 503 because the backend has no usable endpoint.",
        meta: { view: "flow" },
      },
      {
        id: "pod",
        label: "Web pod",
        kind: "service",
        health: pod,
        utilization: clamp(values.routedShare),
        sublabel:
          values.controllerMissing || values.portMatch === 0
            ? "Ready, receiving no traffic"
            : "Ready, receiving traffic",
        detail: values.controllerMissing
          ? "The pod is Ready, but no controller has programmed a route to the Service. The workload is healthy and unreachable through this Ingress."
          : values.portMatch === 1
            ? "The pod is Ready and serves the request path selected by the Ingress."
            : "The pod is Ready, but the Ingress points at a port it does not serve. A healthy workload can still be unreachable through this route.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge(
        "client-controller",
        "client",
        "controller",
        clamp(values.controllerMissing ? 0 : values.routedShare + values.unavailableShare),
        controller,
        "HTTPS",
      ),
      edge(
        "controller-rules",
        "controller",
        "rules",
        clamp(
          values.controllerMissing ? 0 : (values.hostCoverage / 100) * (values.pathCoverage / 100),
        ),
        rule,
        "match",
      ),
      edge(
        "rules-service",
        "rules",
        "service",
        clamp(
          values.controllerMissing ? 0 : (values.hostCoverage / 100) * (values.pathCoverage / 100),
        ),
        worst(rule, service),
        "backend",
      ),
      edge(
        "service-pod",
        "service",
        "pod",
        clamp(values.routedShare),
        worst(service, pod),
        "targetPort",
      ),
    ],
    metrics: [
      metric(
        "routed-rps",
        "Requests routed to a pod",
        values.routed,
        " rps",
        undefined,
        undefined,
        "rps",
      ),
      metric("not-found-rate", "404 rate", values.notFoundRate, "%", 1, 5, "percent"),
      metric("unavailable-rate", "503 rate", values.unavailableRate, "%", 1, 5, "percent"),
      metric(
        "routed-share",
        "Routed share",
        values.routedShare * 100,
        "%",
        undefined,
        undefined,
        "percent",
      ),
      metric(
        "controller-missing",
        "Controller missing",
        values.controllerMissing ? 1 : 0,
        "",
        0.5,
        1,
        "count",
      ),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      routed: values.routedShare,
      notFound: values.notFoundRate,
      unavailable: values.unavailableRate,
      controllerMissing: values.controllerMissing,
    },
    summary: values.controllerMissing
      ? "No controller handles this Ingress class. Zero routes are programmed; clients fail before HTTP, so the 404 and 503 rates remain zero."
      : `${Math.round(values.routed).toLocaleString()} rps routed, ${Math.round(values.notFoundRate)}% 404, ${Math.round(values.unavailableRate)}% 503. Controller class handled.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = 0.015 * Math.sin((index + (seed % 6)) / 3.1);
      return Math.max(0, item.value * (1 + wave));
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "not-found-rate",
    metricId: "not-found-rate",
    warn: 1,
    crit: 5,
    title: "The controller has no matching host or path rule",
    cause:
      "The request reaches the Ingress controller, but its Host or path does not match a rule. The object may be correct for another hostname. A 404 at the controller means the request never selected a backend Service.",
    fix: "Compare the request Host and path with the Ingress rules, including pathType and any rewrite annotation. Add the missing rule or correct the client hostname.",
    checkFirst: [
      "Run kubectl describe ingress and compare the Host, Path, and Backend columns.",
      "Check the request Host header and path at the controller access log.",
      "Check pathType, rewrites, and default backend behavior for the request.",
    ],
  },
  {
    id: "controller-missing",
    metricId: "controller-missing",
    warn: 0.5,
    crit: 1,
    title: "No controller is handling the Ingress class",
    cause:
      "The Ingress object is stored, but no controller reconciles its ingressClassName. No listener or route is programmed, so clients fail before HTTP; the 404 and 503 rates stay at zero because no routing layer is answering.",
    fix: "Install a controller for the class or correct ingressClassName. Check the Ingress status for an address and the controller logs for the object.",
    checkFirst: [
      "Check whether an ingress controller is installed and running.",
      "Compare ingressClassName with the classes the controller watches.",
      "Check Ingress status for a load balancer or address.",
    ],
  },
  {
    id: "unavailable-rate",
    metricId: "unavailable-rate",
    warn: 1,
    crit: 5,
    title: "The rule matches but the backend cannot serve",
    cause:
      "A host and path rule matched, but the named Service has no Ready endpoint on the port the Ingress uses. The controller returns 503 instead of 404 because routing succeeded and the backend failed.",
    fix: "Check the Service name and port in the Ingress backend, then check Service endpoints and the container port. A common cause is an Ingress that points at port 80 while the Service exposes a different port.",
    checkFirst: [
      "Compare the Ingress backend Service name and port with the Service definition.",
      "Check EndpointSlice ready addresses and the container targetPort.",
      "Check controller logs for upstream connection or no-endpoint errors.",
    ],
  },
];

export const kubernetesIngressModel: SimModel = {
  id: "kubernetes-ingress",
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
      values.controllerMissing
        ? `No controller handles this Ingress class, so zero of ${DEMAND_RPS.toLocaleString()} rps are routed. The controller-missing state is not an HTTP 404 or 503; no listener answers.`
        : `At ${DEMAND_RPS.toLocaleString()} rps of illustrative demand, ${Math.round(values.routed).toLocaleString()} rps reach a pod, ${Math.round(values.notFound).toLocaleString()} rps get 404, and ${Math.round(values.unavailable).toLocaleString()} rps get 503.`,
      `Host coverage is ${Math.round(values.hostCoverage)}% and path coverage is ${Math.round(values.pathCoverage)}%. A request must match both before the controller selects the backend Service.`,
    ];
    if (values.controllerMissing) {
      items.push(
        "No controller is watching this Ingress class. The object can exist indefinitely without a listener or route; the fix is controller installation or a matching ingressClassName, not another rule.",
      );
    } else if (values.portMatch === 0) {
      items.push(
        "The host and path match, so the controller returns 503 rather than 404. The rule points at a Service port that no pod serves; check the Service port and targetPort before editing the Ingress.",
      );
    } else if (values.notFoundRate > 0) {
      items.push(
        "The controller is healthy and the backend is healthy, but some requests use a Host or path with no rule. A 404 here is a routing configuration gap, not an application error.",
      );
    } else {
      items.push(
        "Every modeled request matches a rule and reaches a serving backend. The remaining checks are TLS termination, path rewriting, and whether the default backend behaves as expected.",
      );
    }
    items.push(
      "TLS is terminated by the controller using the certificate named in the Ingress or its controller configuration. TLS protects the connection; it does not make a host or path rule match.",
    );
    return items;
  },
  legend: [
    { label: "Routed", tone: "ok" },
    { label: "Partial rule coverage", tone: "warn" },
    { label: "404 or 503", tone: "crit" },
    { label: "No controller", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description:
      "One controller handles the class, every Host and path matches a rule, and the backend port serves.",
    tone: "ok",
    params: defaults({ hostCoverage: 100, pathCoverage: 100, classMatch: 1, servicePortMatch: 1 }),
  },
  {
    id: "peak",
    label: "One host missing",
    description:
      "A low-traffic hostname has no rule. Four percent of requests return 404 while the rest route.",
    tone: "warn",
    params: defaults({ hostCoverage: 96, pathCoverage: 100, classMatch: 1, servicePortMatch: 1 }),
  },
  {
    id: "failure",
    label: "Host rule mismatch",
    description:
      "Rules cover only one of two hostnames. Forty percent of requests reach the controller and get 404.",
    tone: "crit",
    params: defaults({ hostCoverage: 60, pathCoverage: 100, classMatch: 1, servicePortMatch: 1 }),
  },
  {
    id: "port-mismatch",
    label: "Wrong backend port",
    description:
      "The host and path match, but the Ingress names a Service port that no pod serves. Every request returns 503.",
    tone: "crit",
    params: defaults({ hostCoverage: 100, pathCoverage: 100, classMatch: 1, servicePortMatch: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "The missing host rule and backend port are corrected. Every request matches and reaches a Ready pod.",
    tone: "ok",
    params: defaults({ hostCoverage: 100, pathCoverage: 100, classMatch: 1, servicePortMatch: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-host-mismatch",
  title: "Predict why one hostname returns 404",
  simId: "kubernetes-ingress",
  question:
    "An Ingress serves one hostname correctly and returns 404 for another. The controller is running, the backend Service has Ready pods, and the paths are the same. What is the mismatch?",
  prediction: {
    options: [
      { id: "host", label: "The Ingress has no host rule for the second hostname" },
      { id: "service", label: "The backend Service has no Ready endpoints" },
      { id: "controller", label: "The controller is not installed in the cluster" },
      { id: "tls", label: "The TLS certificate does not cover the second hostname" },
    ],
    correctOptionId: "host",
    explanation:
      "A 404 from the controller means the request matched no host and path rule. The controller is running, and the Service has Ready pods, so routing failed above the backend. An Ingress host is matched against the request Host header; a rule for one hostname does not cover another unless a wildcard or default backend is configured.",
  },
  setup: defaults({ hostCoverage: 60, pathCoverage: 100, classMatch: 1, servicePortMatch: 1 }),
  runFor: 20,
  observe: [
    "Forty percent of requests return 404 and never reach the Service.",
    "The controller and backend Service both look healthy.",
    "The Ingress rule table has a host entry for only one hostname.",
    "Adding the second host rule restores routing without restarting the pods.",
  ],
  explain:
    "An Ingress is a declaration of host and path rules. The controller compiles those rules into listeners and routes. Host matching uses the Host header; path matching uses the configured pathType. If no rule matches, the controller uses its default backend, which usually returns 404. A healthy backend cannot rescue a request that never selected it.",
  fix: defaults({ hostCoverage: 100, pathCoverage: 100, classMatch: 1, servicePortMatch: 1 }),
  debrief:
    "The fix was a missing host rule, not a pod restart. The useful split is 404 versus 503: 404 means the controller did not select a backend, while 503 means it selected one that could not serve. That one distinction usually tells you whether to edit the Ingress or the Service behind it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Ingress is an API object that declares HTTP routing rules: a host, a path, and a backend Service and port. It can also declare TLS settings. The object is only a specification. An ingress controller watches objects of its ingressClassName, validates them, and programs a data plane such as a load balancer or proxy. Without a controller, the Ingress object has no listener and routes no traffic.",
  },
  {
    type: "p",
    text: "A request passes three checks. The controller first matches the Host header against the rules. Then it matches the path, using the rule's pathType. Finally it forwards to the named Service and port. A failure at the first two checks usually returns 404 because no backend was selected. A failure at the last check usually returns 503 because the backend was selected but has no Ready endpoint on that port.",
  },
  {
    type: "compare",
    leftTitle: "404 from the ingress layer",
    rightTitle: "503 from the ingress layer",
    rows: [
      {
        label: "Meaning",
        left: "No host or path rule matched",
        right: "A rule matched, but the Service has no ready backend on the named port",
      },
      {
        label: "First check",
        left: "Ingress Host, Path, pathType, ingressClassName",
        right: "Service name, port, EndpointSlice, targetPort",
      },
      {
        label: "Typical fix",
        left: "Add or correct a rule",
        right: "Correct the backend port or restore endpoints",
      },
      {
        label: "Application logs",
        left: "No request reached the app",
        right: "May show no request or a connection error",
      },
    ],
  },
  {
    type: "p",
    text: "A missing controller is a third state. The Ingress object exists, but no controller has reconciled its class, so there is no listener or HTTP routing layer. Clients fail before HTTP, and the 404 and 503 rates stay at zero because no controller is answering. Treat that as an installation or class-matching problem, not a host-rule problem.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The controller is the bridge between the API object and the data plane. It may run as a Deployment behind a LoadBalancer Service, or as a managed cloud load balancer. It watches Ingress, Service, EndpointSlice, and Secret objects. That means a missing hostname can be an Ingress problem, while a missing endpoint is a Service or readiness problem. TLS termination also happens at the controller, using a certificate from a Secret or an external certificate manager.",
  },
  {
    type: "p",
    text: "The request shares are illustrative: 10,000 rps is a teaching volume, and host and path coverage are percentages of that traffic. The routing logic is the lesson. A partial host rule produces partial 404s, a wrong backend port produces 503s, and a missing controller produces no route at all.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Routed requests: the rps that matched a rule and reached a serving pod.",
      "404 rate: requests the controller could not match to a host or path rule.",
      "503 rate: requests that matched a rule but found no usable backend.",
      "Rule coverage: the share of requests covered by host and path rules.",
      "Controller-missing state: no route programmed, with 404 and 503 rates at zero.",
      "Controller and backend node states, which separate a routing gap from a serving gap.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply One host missing for a warning-sized 404 rate. Apply Host rule mismatch to see the production question, then Wrong backend port to compare 404 with 503. Set Ingress class handled to 0 to see the no-route state. Run the experiment before revealing the explanation, then apply Recovery.",
  },
  {
    type: "p",
    text: "Read the controller access log before editing anything. The Host header, path, matched rule, backend, and response status tell you whether the request failed at selection or at the backend. Guessing between an Ingress edit and a Service edit without that line is how a small routing bug becomes a broad outage.",
  },
  { type: "sim", simId: "kubernetes-ingress" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The host-mismatch preset covered only one of two hostnames. Every request still reached the controller, but 40% carried a Host header with no rule and received 404 before the Service was selected. The backend pods were Ready the whole time. The port-mismatch preset produced the other status: the host and path matched, so the controller selected the Service, but the named port had no serving endpoint and returned 503.",
  },
  {
    type: "p",
    text: "Recovery restored full host and path coverage and a serving backend port. Routing returned to 100% without restarting pods, because neither failure was in the application process. The controller was doing its job in both cases: returning 404 when it had no route, and 503 when its chosen route could not connect. The class-missing state is different again: with no controller, no listener returns either status, so clients fail before HTTP and the 404 and 503 panels stay at zero.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Controller access logs with Host, path, matched rule, backend, and response status.",
      "Ingress status and events showing whether the controller accepted the object.",
      "ingressClassName and controller version, which determine supported annotations and path behavior.",
      "Service endpoints and targetPort for a 503, not just pod readiness.",
      "TLS certificate and Secret state for handshake failures, which are separate from 404 and 503.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Split by state. If no route exists and both 404 and 503 are zero, check the controller and ingressClassName first. For 404, compare the request Host and path with the Ingress rules. For 503, compare the Ingress backend port with the Service port and confirm the Service has Ready endpoints on the container port.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Read the controller access log for the failing request.",
      "If 404 and 503 are both zero, check the controller and ingressClassName before editing rules.",
      "For 404, correct the host, path, or pathType.",
      "For 503, correct the Service name or port, then restore Ready endpoints.",
      "Check the default backend behavior before relying on it for unknown hosts.",
      "Verify TLS certificate coverage separately from HTTP routing.",
      "Test the exact Host header and path from outside the cluster after the change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A wildcard host rule is convenient and can route traffic you did not intend.",
      "A default backend that returns 404 is safer than one that silently serves the wrong app.",
      "Prefix paths are flexible and can overlap; exact paths are safer and less convenient.",
      "Centralizing TLS at the controller simplifies certificate management and adds a critical shared hop.",
      "Controller-specific annotations add features and reduce portability across ingress implementations.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "404-vs-503",
    question:
      "Users get 404 for one hostname and 200 for another. Walk me through the diagnosis and the fix.",
    difficulty: 2,
    hints: [
      "404 is returned before a backend is selected.",
      "Check the Host header against the Ingress rule table.",
    ],
    answer:
      "I would start at the controller access log and confirm the Host header and path on a failing request. Then I would compare them with the Ingress rules, including pathType and any rewrite. If the controller is running and the backend has endpoints, the missing piece is the host or path rule. I would add the rule or correct the client hostname, then test the exact Host header from outside the cluster. I would not restart the backend, because a 404 shows the request never selected it.",
    followUps: [
      "How would a wildcard host change the diagnosis?",
      "What if the 404 comes from the application instead of the controller?",
      "How would you test the fix without changing DNS?",
    ],
    redFlags: [
      "Restarts the application first.",
      "Confuses a 404 with a 503.",
      "Ignores the Host header.",
    ],
    rubric: [
      "Uses the controller access log.",
      "Checks host and path rules.",
      "Distinguishes controller 404 from application 404.",
      "Tests the external path after the fix.",
    ],
  },
  {
    id: "controller-missing",
    question:
      "An Ingress object exists and looks correct, but no traffic reaches it. What could be missing?",
    difficulty: 2,
    hints: [
      "The object is not the data plane.",
      "The class selects which controller reconciles it.",
    ],
    answer:
      "I would check whether an ingress controller is installed and whether its ingressClassName matches the object. I would also check the controller's status, its Service or load balancer address, and its logs for rejected objects. If no controller watches the class, the rules are never compiled into a listener, and clients fail before HTTP rather than receiving a controller 404. If a controller exists, I would check whether the Ingress status has an address and whether the external DNS record points at it.",
    followUps: [
      "How does the default IngressClass work?",
      "What would you check if the Ingress status has no address?",
      "How would you verify the controller actually watches the class?",
    ],
    redFlags: [
      "Assumes the object programs a load balancer by itself.",
      "Edits rules before checking the controller.",
      "Ignores the Ingress status.",
    ],
    rubric: [
      "Checks controller installation and class.",
      "Checks status and address.",
      "Separates API object from data plane.",
      "Verifies external DNS.",
    ],
  },
  {
    id: "backend-port",
    question:
      "The Ingress matches the host and path, but every request returns 503. What do you check?",
    difficulty: 3,
    hints: [
      "A 503 means routing succeeded and the backend failed.",
      "The Service can exist with no endpoint on the named port.",
    ],
    answer:
      "I would compare the Ingress backend Service name and port with the Service definition and the container targetPort. Then I would check EndpointSlice addresses and whether the pods are Ready on that port. A common cause is an Ingress that names port 80 while the Service exposes a different port, or a Service selector that matches no pods. I would also check controller logs for upstream connection errors. The Ingress rule may be correct; the backend contract is broken.",
    followUps: [
      "How would a NetworkPolicy produce a similar symptom?",
      "What would the controller log show for no endpoints?",
      "When would you change the Service instead of the Ingress?",
    ],
    redFlags: [
      "Adds another host rule.",
      "Restarts the controller without checking endpoints.",
      "Ignores the Service port.",
    ],
    rubric: [
      "Checks backend Service and port.",
      "Checks endpoints and readiness.",
      "Reads controller logs.",
      "Chooses the right object to change.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every external hostname has an explicit Ingress rule or an intentional default backend.",
      "The ingressClassName matches a running controller.",
      "Backend Service names and ports are tested from outside the cluster.",
      "TLS certificates and Secrets are monitored for expiry.",
      "Path types and rewrite annotations have a test for the exact production paths.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Split the failure by status code: 404, 503, or TLS handshake.",
      "Read the controller access log for Host, path, matched rule, and backend.",
      "Check Ingress status and controller health.",
      "Check Service endpoints and targetPort for 503 responses.",
      "Check certificate and Secret state for handshake failures.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Correct the host, path, class, or backend port that broke routing.",
      "Verify the exact Host header and path from outside the cluster.",
      "Add a synthetic check for each production hostname.",
      "Document which controller owns the class and its supported annotations.",
    ],
  },
];

const references = [
  {
    title: "Ingress",
    url: "https://kubernetes.io/docs/concepts/services-networking/ingress/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Ingress rules, host and path matching, path types, TLS, and the default backend.",
  },
  {
    title: "Ingress controllers",
    url: "https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Why an Ingress needs a controller and how ingressClassName selects one.",
  },
  {
    title: "Ingress-NGINX controller",
    url: "https://kubernetes.github.io/ingress-nginx/",
    publisher: "Kubernetes SIG Network",
    kind: "docs" as const,
    note: "A concrete controller implementation, its annotations, and its routing behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "kubernetes-ingress": {
      model: kubernetesIngressModel,
      presets,
      instructions:
        "Start Healthy, then apply One host missing for a warning-sized 404 rate. Apply Host rule mismatch and Wrong backend port to compare 404 with 503. Run the experiment before revealing the explanation, then apply Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 10,000 rps demand and host and path coverage percentages are teaching values; Ingress rule, path, class, and backend behavior follow the Kubernetes documentation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "kubernetes-services-networking",
    "kubernetes-pods-deployments",
    "mesh-ingress",
    "traffic-l4-vs-l7",
  ],
};
