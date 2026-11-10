import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MODE_NAMES = ["No health check", "Custom health status", "ECS container health"];

const params: ParamSpec[] = [
  {
    id: "instanceCount",
    label: "Registered instances",
    min: 4,
    max: 12,
    step: 1,
    value: 8,
    unit: " instances",
    group: "Registry",
    help: "Tasks registered under one Cloud Map service. A private DNS namespace returns these addresses for the service name.",
    format: "count",
  },
  {
    id: "unhealthyShare",
    label: "Instances failing health",
    min: 0,
    max: 60,
    step: 5,
    value: 0,
    unit: "%",
    group: "Health",
    help: "Share of registered instances whose application is failing. Without a health status they stay registered and keep receiving traffic.",
    format: "percent",
  },
  {
    id: "healthCheckMode",
    label: "Instance health status",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Health",
    help: "0 registers instances with no health signal. 1 uses a custom health status that the application or an external monitor updates with UpdateInstanceCustomHealthStatus. 2 relies on ECS container health to set instance health.",
    format: "count",
  },
  {
    id: "dnsTtlSeconds",
    label: "DNS record TTL",
    min: 5,
    max: 120,
    step: 5,
    value: 15,
    unit: " s",
    group: "DNS",
    help: "How long a resolver may cache an answer. TTL affects stale answers; it does not make an unhealth-checked instance disappear.",
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

interface Values {
  instances: number;
  badShare: number;
  unhealthy: number;
  mode: number;
  modeName: string;
  ttl: number;
  checked: boolean;
  healthy: number;
  resolvable: number;
  stale: number;
  queryFailures: number;
  healthLag: number;
}

function compute(p: Params): Values {
  const instances = Math.round(clamp(num(p, "instanceCount", 8), 4, 12));
  const badShare = clamp(num(p, "unhealthyShare", 0), 0, 60);
  const unhealthy = Math.min(instances, Math.round((instances * badShare) / 100));
  const mode = Math.round(clamp(num(p, "healthCheckMode", 2), 0, 2));
  const ttl = clamp(num(p, "dnsTtlSeconds", 15), 5, 120);
  const checked = mode > 0;
  const healthy = instances - unhealthy;
  const staleFraction = checked ? unhealthy * clamp(ttl / 120) : unhealthy;
  const answerable = Math.round(staleFraction * 10) / 10;
  const queryFailures = instances > 0 ? (answerable / instances) * 100 : 0;
  return {
    instances,
    badShare,
    unhealthy,
    mode,
    modeName: MODE_NAMES[mode],
    ttl,
    checked,
    healthy,
    resolvable: checked ? healthy : instances,
    stale: answerable,
    queryFailures: clamp(queryFailures, 0, 100),
    healthLag: unhealthy > 0 ? (mode === 0 ? 300 : mode === 1 ? 60 : 10) : 0,
  };
}

function healthOf(values: Values): Health {
  if (values.queryFailures >= 5 || values.stale >= 3 || values.healthLag >= 90) return "crit";
  if (values.queryFailures >= 1 || values.stale >= 1 || values.healthLag >= 30) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Values): SimFrame {
  const health = healthOf(values);
  const registryHealth: Health =
    values.mode === 0 && values.unhealthy > 0 ? "crit" : values.unhealthy > 0 ? "warn" : "ok";
  const endpointHealth: Health = values.healthy === values.instances ? "ok" : values.healthy > 0 ? "warn" : "crit";
  const nodes: SimNode[] = [
    {
      id: "client",
      label: "orders-service",
      kind: "service",
      health,
      sublabel: `${values.queryFailures.toFixed(1)}% failed lookups`,
      detail: `The caller queries checkout.internal through the namespace. ${values.queryFailures.toFixed(1)}% of lookups return an instance that cannot serve in this model.`,
      meta: { failures: Number(values.queryFailures.toFixed(1)) },
    },
    {
      id: "namespace",
      label: "internal.local",
      kind: "dns",
      health: registryHealth,
      sublabel: "private DNS namespace",
      detail: `The namespace groups services for one environment. Names resolve only inside the associated Amazon Virtual Private Cloud (VPC).`,
      meta: { ttl: values.ttl, instances: values.instances },
    },
    {
      id: "service",
      label: "checkout.internal",
      kind: "service",
      health: registryHealth,
      sublabel: `${values.instances} registered · ${values.modeName}`,
      detail: `The Cloud Map service holds ${values.instances} instances. Its health setting is ${values.modeName.toLowerCase()}. ${values.checked ? "Instances marked unhealthy are removed from new answers after the health status changes." : "Every registered instance is returned, whether or not it can serve."}`,
      meta: { registered: values.instances, mode: values.mode },
    },
    {
      id: "healthy",
      label: "Healthy instances",
      kind: "worker",
      health: endpointHealth,
      utilization: clamp(values.healthy / values.instances),
      sublabel: `${values.healthy} of ${values.instances}`,
      detail: `These instances can answer. ${values.checked ? "They remain discoverable while their health status is healthy." : "They are indistinguishable from failing instances because no health status is registered."}`,
      meta: { healthy: values.healthy },
    },
    {
      id: "stale",
      label: "Registered but failing",
      kind: "worker",
      health: values.unhealthy === 0 ? "ok" : values.mode === 0 ? "crit" : "warn",
      utilization: clamp(values.unhealthy / values.instances),
      sublabel: `${values.unhealthy} failing · ${values.stale.toFixed(1)} answerable`,
      detail:
        values.unhealthy === 0
          ? "No failing instance is registered."
          : values.mode === 0
            ? `${values.unhealthy} failing instance(s) have no health status. Discovery returns all of them, so ${values.queryFailures.toFixed(1)}% of lookups fail.`
            : `${values.unhealthy} failing instance(s) are being removed from new answers after the health status update, but cached DNS answers can keep some answerable for up to ${values.ttl.toFixed(0)} seconds.`,
      meta: { unhealthy: values.unhealthy, answerable: Number(values.stale.toFixed(1)) },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("client-namespace", "client", "namespace", 1, health, "query"),
      edge("namespace-service", "namespace", "service", 1, registryHealth, "resolve"),
      edge("service-healthy", "service", "healthy", clamp(values.healthy / values.instances), endpointHealth, "returns"),
      edge("service-stale", "service", "stale", clamp(values.unhealthy / values.instances), registryHealth, "returns"),
    ],
    metrics: [
      metric("query-failures", "Lookups returning a failing instance", values.queryFailures, "%", 1, 5, "percent"),
      metric("stale-instances", "Failing instances still answerable", values.stale, "", 1, 3, "number"),
      metric("health-lag", "Health-status update delay", values.healthLag, " s", 30, 90, "number"),
      metric("registered-instances", "Registered instances", values.instances, "", undefined, undefined, "count"),
      metric("healthy-instances", "Healthy instances", values.healthy, "", undefined, undefined, "count"),
      metric("resolvable-instances", "Instances returned by DNS", values.resolvable, "", undefined, undefined, "count"),
      metric("dns-ttl", "DNS record TTL", values.ttl, " s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, registered: values.instances, unhealthy: values.unhealthy },
    summary: `${values.instances} registered, ${values.healthy} healthy, ${values.modeName.toLowerCase()}, ${values.queryFailures.toFixed(1)}% failed lookups.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 16 }, (_, index) => {
      const wave = Math.sin((index + (seed % 6)) / 2.3) * Math.max(0.2, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "query-failures",
    metricId: "query-failures",
    warn: 1,
    crit: 5,
    title: "Discovery is returning instances that cannot serve",
    cause:
      "The service has no instance health status, or the status is not connected to the signal that matters. Cloud Map returns what the registry holds; without a health status, a failing task stays an eligible endpoint. Cached DNS answers add a second window after removal.",
    fix:
      "Use ECS container health, or update custom instance health from the application's own signal with UpdateInstanceCustomHealthStatus. Then confirm the service no longer returns the failed instance. A shorter TTL helps only after the registry stops returning it.",
    checkFirst: [
      "Check whether the Cloud Map service has a custom health status or ECS container health configured.",
      "Compare registered instances with the tasks that are actually running.",
      "Resolve the service name from a caller and compare the result with the registry.",
    ],
  },
  {
    id: "stale-instances",
    metricId: "stale-instances",
    warn: 1,
    crit: 3,
    title: "Failing instances remain available to discovery",
    cause:
      "An instance is unhealthy but still registered. With no health status, Cloud Map has no reason to stop returning it. With a status update, the update delay and DNS cache still leave a short window.",
    fix:
      "Register failing instances as unhealthy, or enable a check that does so. For ECS tasks, connect the container health signal or let the service deregister the task. Do not treat a TTL change as a substitute for health status.",
    checkFirst: [
      "List the registered instances and their health status.",
      "Check whether the application updates custom health status on failure.",
      "Check task health and the stop reason if the instance should already be gone.",
    ],
  },
  {
    id: "health-lag",
    metricId: "health-lag",
    warn: 30,
    crit: 90,
    title: "Health information is arriving too late to protect callers",
    cause:
      "A health status has a detection path and an update path. With no health status, the delay is effectively unbounded. A status that is updated too slowly lets a failing instance serve traffic through the whole detection window.",
    fix:
      "Tighten the update path within the application's tolerance, and connect it to the signal that predicts failure. If the delay is inherent, make callers retry against another instance and mark the instance unhealthy as soon as the failure is known.",
    checkFirst: [
      "Check the custom health status or ECS container health configuration.",
      "Check when the instance was registered versus when it failed.",
      "Check whether ECS or the application is responsible for updating health.",
    ],
  },
];

export const cloudMapModel: SimModel = {
  id: "containers-cloud-map",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(seed, values);
    seedSeries(frame);
    frame.flags.paramsKey = JSON.stringify(p);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, paramsKey: JSON.stringify(p) };
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, points]) => [key, [...points]]));
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The namespace is internal.local, the service is checkout.internal, and ${values.instances} instances are registered under it.`,
      `The service uses ${values.modeName.toLowerCase()}. ${values.checked ? "A failing check removes the instance from new answers; cached answers can survive for the TTL." : "With no check, a failing instance is still an eligible endpoint."}`,
      `${values.healthy} of ${values.instances} instances are healthy. DNS currently returns ${values.resolvable} of them in this model, and ${values.queryFailures.toFixed(1)}% of lookups fail.`,
      values.stale > 0
        ? `${values.stale} failing instance(s) remain answerable. Removing them from the registry is the first fix; shortening the TTL only helps after that.`
        : "No failing instance is currently answerable; keep the health status aligned with the serving path.",
      "A TTL controls caching. A health status controls registration. Changing one does not replace the other.",
    ];
  },
  legend: [
    { label: "All instances healthy", tone: "ok" },
    { label: "Failing instance registered", tone: "warn" },
    { label: "No health signal", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Eight healthy instances, ECS container health, and a 15-second TTL.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "One failing instance",
    description: "One of eight instances fails while a custom health status removes it from new answers after a 60-second update delay.",
    tone: "warn",
    params: defaults({ instanceCount: 8, unhealthyShare: 15, healthCheckMode: 1, dnsTtlSeconds: 30 }),
  },
  {
    id: "failure",
    label: "No health signal",
    description: "Four of ten instances fail and the service has no health check, so all four stay in rotation.",
    tone: "crit",
    params: defaults({ instanceCount: 10, unhealthyShare: 40, healthCheckMode: 0, dnsTtlSeconds: 120 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Every instance is healthy again and ECS container health feeds the registry.",
    tone: "ok",
    params: defaults({ instanceCount: 8, unhealthyShare: 0, healthCheckMode: 2, dnsTtlSeconds: 15 }),
  },
];

const experiment: Experiment = {
  id: "predict-no-health-check",
  title: "Predict what happens with no instance health check",
  simId: "cloud-map",
  question:
    "Eight instances are registered under one Cloud Map service. Two are failing. The service has no health check, and the DNS TTL is 60 seconds. What does a discovery query return?",
  prediction: {
    options: [
      { id: "healthy", label: "Only the six healthy instances, because Cloud Map checks health by default" },
      { id: "all", label: "All eight, because registration does not depend on health unless a check is configured" },
      { id: "none", label: "No instances, because the service is degraded" },
      { id: "two", label: "Only the two failing instances, so callers can confirm the failure" },
    ],
    correctOptionId: "all",
    explanation:
      "Cloud Map returns registered instances. Without a health status, registration says nothing about whether an instance can serve. The TTL changes how long an answer is cached; it does not filter the answer. Two of eight endpoints fail, so 25% of lookups fail when traffic is spread evenly across them.",
  },
  setup: defaults({ instanceCount: 8, unhealthyShare: 25, healthCheckMode: 0, dnsTtlSeconds: 60 }),
  runFor: 20,
  observe: [
    "Two of the eight registered instances are failing, and both remain in the DNS answer.",
    "Failed lookups settle at 25% while the registry is unchanged.",
    "The removal delay is effectively unbounded because there is no health signal.",
    "Enabling ECS container health removes the failing instances from new answers.",
  ],
  explain:
    "Cloud Map is a registry with namespaces, services, and instances. Health is an input to registration, not an automatic property of it. A DNS namespace returns the registered instances unless a health status changes. TTL bounds the cache, so it can delay the effect of a removal, but it cannot create a removal that never happened.",
  fix: defaults({ instanceCount: 8, unhealthyShare: 0, healthCheckMode: 2, dnsTtlSeconds: 15 }),
  debrief:
    "With ECS container health connected, failing instances are marked unhealthy and new answers exclude them. The tradeoff is detection work: the check needs an interval and a failure threshold, and a custom health status has to be updated by something. A check that is too slow or disconnected is no better than no check, because it reports health without reflecting the serving path.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "AWS Cloud Map is a service registry. Applications register instances under a service, and callers discover them by name. The hierarchy has three levels. A namespace is an environment boundary, such as internal.local. A service is a named capability inside that namespace, such as checkout. An instance is one endpoint, usually an ECS task's IP address and port, with optional attributes.",
  },
  {
    type: "p",
    text: "A private DNS namespace publishes names that resolve only inside the associated Amazon Virtual Private Cloud (VPC). An HTTP namespace has no DNS records and is queried through the Cloud Map API with discovery calls. Both hold the same namespace, service, and instance model. The DNS namespace is convenient for code that already resolves hostnames; the HTTP namespace gives the caller attributes and health status directly.",
  },
  {
    type: "compare",
    leftTitle: "Private DNS namespace",
    rightTitle: "HTTP namespace",
    rows: [
      { label: "How callers read it", left: "Standard DNS lookup", right: "Cloud Map discovery API" },
      { label: "What comes back", left: "IP addresses from the service name", right: "Instances with attributes and health" },
      { label: "Caching", left: "Resolver and client TTLs apply", right: "The caller decides when to refresh" },
      { label: "Best fit", left: "Existing clients that expect a hostname", right: "Clients that need richer endpoint data" },
    ],
  },
  {
    type: "p",
    text: "Registration is not health. A task can register successfully while its application is failing. Cloud Map will keep returning that instance unless something marks it unhealthy or deregisters it. ECS integrates container health with the registry, and an application or external monitor can update custom instance health with UpdateInstanceCustomHealthStatus. The choice determines how quickly a bad endpoint stops being discoverable.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Cloud Map sits between the ECS service scheduler and the caller. When the scheduler starts a task, it registers the task's IP and port. When the task stops, it deregisters. Health checks sit beside that path: they observe the instance and change its status, but they do not control whether the ECS service keeps the task running.",
  },
  {
    type: "p",
    text: "That separation explains a common confusion. A health check can remove an instance from discovery without stopping the task, and a task can be running without being discoverable. The registry describes the endpoint, the service scheduler describes the desired task count, and the load balancer target group describes traffic eligibility. Those are three separate views.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "The namespace, service, and instance count as separate nodes, so registration and health are not confused.",
      "Lookups that return a failing instance, which rise when no health check is configured.",
      "The health removal delay: the gap between an instance failing and new answers excluding it.",
      "Registered but failing instances, which can remain in the registry long after the application stopped serving.",
    ],
  },
  {
    type: "table",
    headers: ["Health setting", "What it observes", "What it does not do"],
    rows: [
      ["No health check", "Nothing; every registered instance stays eligible", "Protect callers from a failing endpoint"],
      ["Custom health status", "A signal updated with UpdateInstanceCustomHealthStatus", "Update itself when the application fails"],
      ["ECS container health", "The container health check inside the task", "Guarantee every dependency is healthy"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply One failing instance to see a custom health status remove it after a delay. Apply No health signal to see all failing instances stay in rotation. Apply Recovery to reconnect health and clear the registry, then run the experiment before the debrief.",
  },
  { type: "sim", simId: "cloud-map" },
  { type: "experiment", experimentId: "predict-no-health-check" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The registry kept returning every instance it held. In the healthy preset, every instance was healthy, so registration and reality agreed. In the failure preset, four of ten instances were failing and the service had no health check, so discovery kept offering all four. Callers failed at a rate set by how traffic spread across the ten endpoints.",
  },
  {
    type: "p",
    text: "The one-failing-instance preset showed the other side of the tradeoff. A custom health status update eventually removed the bad instance, but not instantly: something had to detect the failure and call UpdateInstanceCustomHealthStatus, and cached DNS answers could survive the TTL. Recovery cleared both the failing instances and the cached window.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`ListInstances` or `DiscoverInstances` showing an endpoint that is no longer serving.",
      "DNS resolution returning an IP that is not in the running task list.",
      "Failed lookups clustered on one instance while the service looks healthy at the aggregate level.",
      "A health check configured but not connected to the signal that actually fails.",
      "Tasks that are running and healthy but absent from discovery because registration never completed.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the registered instances with the running tasks and their health. Then check whether the service has a health check and what it observes. Resolve the name from a caller and compare it with the registry. Do not shorten the TTL before confirming the registry is removing bad instances.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "List the instances registered for the service and their health status.",
      "Compare registration with the running tasks and the application's serving state.",
      "Enable a health check that tests the actual path callers use.",
      "Remove or mark failed instances unhealthy as soon as the failure is known.",
      "Shorten the TTL only after the registry stops returning bad instances.",
      "Verify from a caller by resolving the name and exercising the endpoint.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A private DNS namespace fits existing hostname-based clients and adds resolver caching to the failure path.",
      "An HTTP namespace returns attributes and health directly and requires the caller to use the Cloud Map API.",
      "An aggressive health check removes bad instances quickly and can remove a task during a slow but recoverable startup.",
      "A long TTL reduces query load and extends the time a removed instance stays reachable in caller caches.",
      "Automatic ECS deregistration reduces operational work but depends on ECS knowing the task is stopping.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "namespace-design",
    question:
      "You need private DNS for 40 ECS services across three environments. How would you organize Cloud Map namespaces and services?",
    difficulty: 2,
    hints: [
      "The namespace is an environment boundary; the service is a capability.",
      "DNS names must be unique within the namespace.",
    ],
    answer:
      "I would create one private DNS namespace per environment, such as dev.internal, staging.internal, and prod.internal, and associate each with the VPCs that belong to that environment. Inside each namespace I would create one Cloud Map service per logical dependency, such as checkout or payments, and let ECS register task instances under it. That keeps names unique and blast radius bounded by environment. I would avoid mixing environments in one namespace because a name collision or a mistaken query would cross a boundary. If callers need attributes or health status rather than hostnames, I would consider an HTTP namespace for those services.",
    followUps: [
      "What breaks if two environments share one namespace?",
      "When would you choose an HTTP namespace over DNS?",
      "How would you name a service that exists in every environment?",
    ],
    redFlags: [
      "Puts every environment in one namespace.",
      "Creates a namespace per service.",
      "Ignores VPC association.",
    ],
    rubric: [
      "Uses namespace as environment boundary.",
      "Creates service per capability.",
      "Associates namespaces with the right VPCs.",
      "Chooses DNS or HTTP deliberately.",
    ],
  },
  {
    id: "health-check-choice",
    question:
      "A Cloud Map service returns a task that is failing requests. What health check would you use, and what does it miss?",
    difficulty: 3,
    hints: [
      "A check observes one signal and cannot prove every dependency is healthy.",
      "Custom health status requires something to update it.",
    ],
    answer:
      "I would first decide which signal predicts failure for this service. If ECS already runs a container health check that reflects the application, I would connect that. If the failure is business-specific, I would update custom instance health from the application or an external monitor with UpdateInstanceCustomHealthStatus. Every option has a blind spot: a shallow check can pass while a dependency is broken, and a custom status is only as good as the code that updates it. I would also ensure the failing task is deregistered and that callers retry another endpoint during the detection window.",
    followUps: [
      "What happens if the health check endpoint depends on the same failing database?",
      "How does the check interval affect the error rate?",
      "Who should own a custom health update?",
    ],
    redFlags: [
      "Assumes Cloud Map checks health by default.",
      "Uses a shallow ping as proof of readiness.",
      "Ignores the detection window.",
    ],
    rubric: [
      "Chooses a check based on the failure signal.",
      "Names the check's blind spot.",
      "Connects removal and caller retry.",
      "Considers detection delay.",
    ],
  },
  {
    id: "registered-not-serving",
    question:
      "A task is registered in Cloud Map but receives no traffic. What do you check, and what would make the opposite happen?",
    difficulty: 2,
    hints: [
      "Registration, target health, and security groups are different gates.",
      "The registry can return an endpoint that is unreachable.",
    ],
    answer:
      "I would check the full path, not only the registry: whether the service name resolves, whether the returned IP and port match the task, whether the security group allows the caller, and whether a load balancer target group considers the task healthy. A task can also be registered but excluded because a health check marks it unhealthy. The opposite, traffic reaching a dead task, happens when the instance stays registered without a health check or when a caller uses a cached answer past the deregistration. Both directions come from treating registration as the only signal.",
    followUps: [
      "How would you prove the DNS answer is current?",
      "What does a target group add that Cloud Map does not?",
      "Which signal would you alert on for a registration gap?",
    ],
    redFlags: [
      "Checks only the ECS task state.",
      "Assumes registration implies reachability.",
      "Changes the TTL before checking security groups.",
    ],
    rubric: [
      "Checks resolution, port, and network path.",
      "Separates registration from target health.",
      "Explains both stale and missing traffic.",
      "Uses caller-side verification.",
    ],
  },
];

const checklist = [
  {
    title: "Before the service ships",
    items: [
      "The namespace matches the environment and is associated with the correct VPCs.",
      "Each logical dependency has one Cloud Map service with a clear name.",
      "A health check observes the same path callers use, or custom health is updated reliably.",
      "The TTL is chosen from the task replacement rate and the caller's tolerance.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Compare registered instances with running tasks and their health.",
      "Resolve the service name from a caller, not only from the ECS console.",
      "Check whether a health check is configured and when it last changed status.",
      "Check whether the caller caches answers or connections beyond the TTL.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Remove or mark failed instances unhealthy at the source.",
      "Verify that new answers exclude the failed endpoint.",
      "Measure the detection and removal delay against the error budget.",
      "Review namespace and service naming before adding more services.",
    ],
  },
];

const references = [
  {
    title: "What is AWS Cloud Map?",
    url: "https://docs.aws.amazon.com/cloud-map/latest/dg/what-is-cloud-map.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Namespaces, services, instances, and the registry model.",
  },
  {
    title: "AWS Cloud Map health checks",
    url: "https://docs.aws.amazon.com/cloud-map/latest/dg/health-checks.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Health check options and how instance health affects discovery.",
  },
  {
    title: "Service discovery for Amazon ECS",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-discovery.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "How ECS registers tasks with Cloud Map and removes them when tasks stop.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cloud-map": {
      model: cloudMapModel,
      presets,
      instructions:
        "Start Healthy, then apply One failing instance and No health signal. Compare the registry with the returned endpoints, then apply Recovery. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Instance counts, the 10-, 60-, and 300-second health-status delays, and the lookup-failure percentages are teaching values, not Cloud Map limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-service-discovery",
    "containers-services",
    "containers-health-checks",
    "traffic-alb-target-groups",
  ],
};
