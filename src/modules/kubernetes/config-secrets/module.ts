import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimNode,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "replicas",
    label: "Deployment replicas",
    min: 2,
    max: 30,
    step: 1,
    value: 8,
    unit: " pods",
    group: "Deployment",
    help: "Pods running the workload. Every pod holds its own copy of the injected configuration.",
    format: "count",
  },
  {
    id: "rolloutPercent",
    label: "Pods restarted since the change",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Rollout",
    help: "Share of pods replaced after the ConfigMap or Secret changed. Environment variables are only refreshed by a new container.",
    format: "percent",
  },
  {
    id: "injection",
    label: "Injection: env 0, volume 1",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Config",
    help: "0 injects values as environment variables when the container starts. 1 mounts the object as a volume, where kubelet refreshes the files.",
    format: "count",
  },
  {
    id: "reload",
    label: "App reloads mounted files",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Config",
    help: "1 means the process watches the mounted files and re-reads them. Without a reload, a refreshed file does not change the running process.",
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

function healthFor(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

interface Values {
  replicas: number;
  restarted: number;
  rollout: number;
  staleShare: number;
  stalePods: number;
  freshPods: number;
  volumeInjection: boolean;
  reloadEnabled: boolean;
  p99: number;
}

function compute(p: Params): Values {
  const replicas = Math.round(clamp(num(p, "replicas", 8), 2, 30));
  const rollout = clamp(num(p, "rolloutPercent", 100) / 100);
  const volumeInjection = num(p, "injection", 1) >= 1;
  const reloadEnabled = num(p, "reload", 1) >= 1;
  const restarted = Math.round(replicas * rollout);
  const staleShare = volumeInjection && reloadEnabled ? 0 : 1 - rollout;
  const stalePods = Math.round(replicas * staleShare);
  const freshPods = replicas - stalePods;
  const p99 = 40 + staleShare * 220 + Math.max(0, replicas - 16) * 2;
  return {
    replicas,
    restarted,
    rollout,
    staleShare,
    stalePods,
    freshPods,
    volumeInjection,
    reloadEnabled,
    p99,
  };
}

function buildFrame(values: Values, seed: number): SimFrame {
  const staleHealth = healthFor(values.staleShare * 100, 1, 25);
  const nodes: SimNode[] = [
    {
      id: "configmap",
      label: "ConfigMap / Secret",
      kind: "storage",
      health: "ok",
      utilization: 0.2,
      sublabel: "revision 12",
      detail:
        "The API object holds the desired data. A write changes the stored object, not any running process. A Secret is base64 encoded in this object; that is an encoding, not encryption.",
      meta: { view: "flow" },
    },
    {
      id: "kubelet",
      label: "kubelet sync",
      kind: "service",
      health: "ok",
      utilization: values.volumeInjection ? 0.4 : 0.15,
      sublabel: values.volumeInjection ? "refreshes mounted files" : "reads env at start",
      detail: values.volumeInjection
        ? "For a volume mount, kubelet refreshes the projected files after the object changes. The update is eventual, and the application must read the file again."
        : "For environment injection, kubelet resolves the values when it creates the container. A running container keeps the old environment for its whole life.",
      meta: { view: "flow" },
    },
    {
      id: "pods-fresh",
      label: "Pods with new config",
      kind: "service",
      health: "ok",
      utilization: clamp(values.freshPods / Math.max(1, values.replicas)),
      sublabel: `${values.freshPods} pods`,
      detail: "These pods started after the change, or reloaded the mounted file. They serve the current revision.",
      meta: { view: "flow" },
    },
    {
      id: "pods-stale",
      label: "Pods with old config",
      kind: "service",
      health: staleHealth,
      utilization: values.staleShare,
      sublabel: `${values.stalePods} pods`,
      detail:
        "These pods still hold the previous values. They are running and ready, so a readiness check will not remove them. The gap is configuration, not process health.",
      meta: { view: "flow" },
    },
    {
      id: "app",
      label: "Application",
      kind: "service",
      health: staleHealth,
      utilization: values.staleShare,
      sublabel: `${Math.round(values.staleShare * 100)}% stale`,
      detail:
        "Requests that land on a stale pod get the old behavior. The fleet can look healthy while two revisions answer the same request path differently.",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("configmap-kubelet", "configmap", "kubelet", 1, "ok", "watch"),
      edge("kubelet-fresh", "kubelet", "pods-fresh", clamp(values.freshPods / Math.max(1, values.replicas)), "ok", "new values"),
      edge("kubelet-stale", "kubelet", "pods-stale", values.staleShare, staleHealth, "old values"),
      edge("fresh-app", "pods-fresh", "app", clamp(values.freshPods / Math.max(1, values.replicas)), "ok"),
      edge("stale-app", "pods-stale", "app", values.staleShare, staleHealth),
    ],
    metrics: [
      metric("stale-config", "Pods serving stale config", values.staleShare * 100, "%", 1, 25, "percent"),
      metric("stale-pods", "Stale pods", values.stalePods, " pods", 1, 4, "count"),
      metric("p99", "Request p99", values.p99, "ms", 180, 280, "ms"),
      metric("fresh-pods", "Pods on current config", values.freshPods, " pods", undefined, undefined, "count"),
      metric("rollout-progress", "Pods restarted", values.restarted, " pods", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.replicas} pods, ${values.stalePods} stale, ${values.freshPods} current. ${
      values.volumeInjection ? "Volume mount" : "Environment injection"
    }; reload ${values.reloadEnabled ? "enabled" : "disabled"}.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = item.value * 0.02 * Math.sin((index + (seed % 5)) / 3.1);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "stale-config",
    metricId: "stale-config",
    warn: 1,
    crit: 25,
    title: "Running pods are serving stale configuration",
    cause:
      "Environment variables are resolved when a container is created, so a ConfigMap or Secret update does not reach a running container. A volume mount refreshes the file, but the process keeps its in-memory copy unless it reloads. Restarting a share of pods leaves the rest on the old revision.",
    fix:
      "Roll the Deployment so every pod is recreated, or mount the object as a volume and make the application watch and reload the file. If only part of the fleet was rolled, complete the rollout before declaring the change done.",
    checkFirst: [
      "Compare the object's resourceVersion with the environment or file content inside a running pod.",
      "Check whether the workload uses env or a volume mount, and whether the process reloads the file.",
      "Check the Deployment rollout status and the pods' start times, not just the object's update time.",
    ],
  },
  {
    id: "stale-pods",
    metricId: "stale-pods",
    warn: 1,
    crit: 4,
    title: "A meaningful share of the fleet is on the previous revision",
    cause:
      "A partial rollout, a paused Deployment, or a reload that only some pods perform leaves two configuration revisions serving traffic at the same time. The aggregate error rate can stay low while a subset of requests uses old behavior.",
    fix:
      "Finish the rollout and verify every pod reports the new revision. If a reload is in place, check that it runs in every container and does not depend on a file watch that the runtime drops.",
    checkFirst: [
      "Group pods by start time and by the config revision they report.",
      "Check for a paused or stuck Deployment and for pods that predate the change.",
      "Check whether the application reads config once at startup or on every request.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 180,
    crit: 280,
    title: "Requests that reach a stale pod are slower",
    cause:
      "The stale revision may use a different timeout, retry policy, or endpoint. Mixed revisions also make latency dashboards bimodal, so an average can hide the slower cohort.",
    fix:
      "Finish the rollout or reload before tuning latency. Then compare latency by pod revision to confirm both cohorts behave the same.",
    checkFirst: [
      "Split p99 by pod and by config revision.",
      "Check whether the stale revision points at a different dependency or timeout.",
      "Confirm the rollout is complete before changing capacity.",
    ],
  },
];

export const configSecretsModel: SimModel = {
  id: "kubernetes-config-secrets",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(compute(defaults()), seed);
    seedSeries(frame);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 1));
    next.t = frame.t;
    next.series = { ...frame.series };
    next.events = [...frame.events];
    const jitter = 1 + rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value * jitter) } : item,
    );
    next.flags = {
      ...frame.flags,
      ...next.flags,
      elapsed: Math.max(0, Number(frame.flags.elapsed ?? 0)) + Math.max(0, dt),
      paramsKey: JSON.stringify(p),
    };
    if (values.stalePods > 0 && frame.flags.staleEvent !== 1) {
      pushEvent(next, {
        id: "stale-config-detected",
        severity: "warn",
        title: "Pods are still serving the previous configuration",
        detail:
          "The API object changed, but these containers have not restarted or reloaded. Readiness stays green because the process is healthy; only its configuration is old.",
        nodeId: "pods-stale",
        metricId: "stale-config",
      });
      next.flags.staleEvent = 1;
    }
    if (values.stalePods === 0) next.flags.staleEvent = 0;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const lines = [
      `${values.stalePods} of ${values.replicas} pods are on the previous configuration (${Math.round(values.staleShare * 100)}%).`,
      values.volumeInjection
        ? "A volume mount lets kubelet refresh the file, but the update is eventual and does not change a value the process already read."
        : "Environment variables are fixed at container start. Only a new container picks up a changed value.",
      values.reloadEnabled
        ? "The application reloads mounted files, so a volume mount can converge without a restart. Environment injection still needs a restart."
        : "No reload is modeled. A mounted file can change on disk while the process keeps serving its startup copy.",
      "A Secret is base64 encoded inside the API object. Base64 is not encryption; encryption at rest is a separate API server configuration.",
    ];
    return lines;
  },
  legend: [
    { label: "Current config", tone: "ok" },
    { label: "Partial rollout", tone: "warn" },
    { label: "Stale revision serving", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Eight pods read the ConfigMap from a mounted volume and reload the file after a change.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Partial rollout",
    description: "A 24-pod Deployment pauses with 10% of pods still on the previous environment values.",
    tone: "warn",
    params: defaults({ replicas: 24, rolloutPercent: 90, injection: 0, reload: 0 }),
  },
  {
    id: "failure",
    label: "Stale environment",
    description: "Twelve pods were never restarted after a ConfigMap change, so every pod serves the old values.",
    tone: "crit",
    params: defaults({ replicas: 12, rolloutPercent: 0, injection: 0, reload: 0 }),
  },
  {
    id: "recovery",
    label: "Roll the pods",
    description: "The same environment injection, but the whole Deployment is restarted so every pod reads the new values.",
    tone: "ok",
    params: defaults({ replicas: 12, rolloutPercent: 100, injection: 0, reload: 0 }),
  },
  {
    id: "volume-reload",
    label: "Volume with reload",
    description: "The object is mounted as a volume and the app reloads it, so no restart is needed for the next change.",
    tone: "ok",
    params: defaults({ replicas: 8, rolloutPercent: 0, injection: 1, reload: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-mounted-config",
  title: "Predict whether a mounted ConfigMap reaches the process",
  simId: "config-secrets",
  question:
    "A ConfigMap is mounted as a volume in six pods. The file on disk is refreshed by kubelet after the object changes. The application read the file once at startup, has not reloaded, and the pods have not restarted. Is the application using the new value?",
  prediction: {
    options: [
      { id: "yes-sync", label: "Yes. The volume is refreshed, so the process sees the new value" },
      { id: "no-reload", label: "No. The file changed, but the running process keeps its in-memory copy" },
      { id: "yes-env", label: "Yes. Mounted values bypass the environment and always update" },
      { id: "no-immutable", label: "No. ConfigMaps are immutable once a pod mounts them" },
    ],
    correctOptionId: "no-reload",
    explanation:
      "A volume mount decouples the file from the container start: kubelet refreshes the projected file when the object changes, with an eventual delay. That does not update a value the process already read into memory. Without a file watch or a reload signal, the application keeps the old value until the container restarts. Environment injection is stricter still: the value is fixed when the container is created and no kubelet refresh can change it.",
  },
  setup: defaults({ replicas: 6, rolloutPercent: 0, injection: 1, reload: 0 }),
  runFor: 20,
  observe: [
    "The ConfigMap node shows the new revision while all six pods remain stale.",
    "Kubelet sync refreshes the mounted file, but the stale share stays at 100% because the process did not reload.",
    "Restarting the pods or enabling reload moves the stale share to zero.",
    "The Secret version of the same setup has identical delivery behavior; encryption at rest is a separate control.",
  ],
  explain:
    "Delivery has two steps: the value must reach the container, and the process must read it. A volume mount handles the first step eventually. A reload handles the second. Environment injection skips the file entirely and needs a new container for both. This is why a ConfigMap edit can be visible in the API and absent from the request path.",
  fix: defaults({ replicas: 6, rolloutPercent: 100, injection: 1, reload: 0 }),
  debrief:
    "The mounted file was current and the application was not. Restarting the pods made the process read the file again. A reloader or a file watch would avoid the restart, at the cost of making the application responsible for handling partial writes and duplicate reloads. For Secrets, the same rules apply, and encryption at rest must be configured separately.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A ConfigMap holds non-secret configuration as key-value pairs. A Secret holds data that should be restricted, such as tokens and passwords. Both are API objects that a pod consumes either as environment variables or as files in a mounted volume. Neither object is a live channel into a running process. The container receives a copy at start, and the copy does not change by itself.",
  },
  {
    type: "p",
    text: "The delivery behavior differs by method. Environment variables are resolved when the container is created, so a running container keeps the old values for its lifetime. A volume mount is refreshed by kubelet when the object changes, but the refresh is eventual and only changes the file. The application still has to read the file again. A Deployment rollout recreates pods and therefore makes every consumer start from the current object, at the cost of replacing the fleet.",
  },
  {
    type: "p",
    text: "A Secret is stored as base64-encoded data in the API object. Base64 is an encoding that anyone with read access can decode; it is not encryption. Encryption at rest is a separate API server configuration that protects the data in etcd. Treat read access to Secrets as equivalent to read access to the credential itself.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "table",
    headers: ["Layer", "What it does", "Update behavior"],
    rows: [
      ["ConfigMap or Secret object", "Stores the desired data", "Changes immediately in the API"],
      ["kubelet", "Projects env or volume data into the pod", "Env at container start; volume files refreshed eventually"],
      ["Container process", "Reads env once or reads files", "Keeps old values until restart or reload"],
      ["Deployment", "Replaces pods on a template or annotation change", "New pods start with the current object"],
    ],
  },
  {
    type: "p",
    text: "This model uses eight pods and a 40 ms baseline request latency as illustrative values. It shows the delivery path, not a guarantee about kubelet's sync interval, which depends on the cluster and the volume plugin. The important boundary is between the object, the container, and the process.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Stale pods: the count that still holds the previous values.",
      "Pods on current config: the part of the fleet that restarted or reloaded.",
      "Injection method and reload: the two controls that decide whether a change can converge without a restart.",
      "Request p99: a signal that mixed revisions can produce different behavior on the same route.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy with a mounted volume and reload enabled. Switch to environment injection without restarting pods and watch the stale share jump to 100%. Then apply Roll the pods to see the same configuration converge. Finish with Volume with reload to compare a no-restart path.",
  },
  { type: "sim", simId: "config-secrets" },
  { type: "experiment", experimentId: "predict-mounted-config" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset kept every pod running after the ConfigMap changed. The API object was current, the kubelet had nothing new to project into an environment variable, and the application kept serving the old values. The pods stayed ready, so a health check would not have removed them from the Service.",
  },
  {
    type: "p",
    text: "The recovery preset restarted the Deployment, which recreated every container and resolved the current values. The volume-with-reload preset reached the same result without a restart: kubelet refreshed the file and the application read it again. The experiment showed the intermediate case, where the file was current but the process was not.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "The object's metadata.resourceVersion and the pod's start time; a pod older than the change is suspect.",
      "The Deployment rollout status, observed generation, and the ReplicaSet revisions.",
      "The effective environment inside a pod, or the file content at the mounted path, compared with the object.",
      "Application logs for config reload events, parse errors, or a startup-only configuration message.",
      "Secret access: who can read the object, whether encryption at rest is configured, and whether the token is mounted unnecessarily.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the object's update time with the pod start time and the process's config revision. If the pod predates the change and uses environment variables, no amount of waiting will update it. If it uses a volume, check whether the file changed and whether the application reloaded it.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm which pods are stale and which injection method they use.",
      "For environment injection, roll the Deployment or change the pod template to force recreation.",
      "For a volume mount, make the application watch the file or send it a reload signal after the file changes.",
      "Add a checksum annotation or a config revision label so a config change also changes the pod template.",
      "Verify the rollout reached every replica and that no pod predates the change.",
      "For Secrets, restrict read access and configure encryption at rest; do not treat base64 as protection.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Environment injection is simple and requires a restart for every change.",
      "A volume mount avoids restarts but pushes reload correctness into the application.",
      "A checksum annotation makes config changes visible to the Deployment and causes a full rollout each time.",
      "A reloader adds a controller and a failure mode of its own, but removes the need for every team to implement file watching.",
      "Encryption at rest protects etcd media, not a running pod or a user with read access to the Secret.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "configmap-not-applied",
    question:
      "A ConfigMap was updated twenty minutes ago and the application still returns the old value. The pods are Ready. What do you check?",
    difficulty: 2,
    hints: [
      "Compare the object update time with the pod start time.",
      "Environment variables and volume mounts fail differently.",
    ],
    answer:
      "I would first check how the pod consumes the object. If it uses environment variables, the running container cannot see the change and needs a restart or a new ReplicaSet. If it uses a volume mount, I would inspect the file inside the pod and then check whether the application reloads it. I would compare the pod start time with the object's resourceVersion or update time and check the Deployment rollout status. A Ready pod only proves the process is alive, not that it has the current configuration.",
    followUps: [
      "How would you make a ConfigMap change trigger a rollout automatically?",
      "What is the difference between a volume refresh and an application reload?",
      "Why does a Secret update behave the same way?",
    ],
    redFlags: [
      "Assumes ConfigMaps update running processes.",
      "Restarts pods without checking the injection method.",
      "Treats readiness as proof of current configuration.",
    ],
    rubric: [
      "Separates object, container, and process.",
      "Checks the injection method.",
      "Verifies pod age and rollout state.",
      "Names a durable fix.",
    ],
  },
  {
    id: "secret-base64",
    question:
      "A team stores database passwords in a Secret and says the values are encrypted because they are base64. Is that correct, and what would you change?",
    difficulty: 2,
    hints: [
      "Base64 is reversible without a key.",
      "Encryption at rest is an API server setting, not a Secret field.",
    ],
    answer:
      "No. Base64 is an encoding, and anyone who can read the Secret can decode it. The data is protected only by access control and, if configured, encryption at rest in etcd. I would restrict who can read Secrets in that namespace, avoid mounting service account tokens where they are not needed, and confirm the API server has an encryption provider configured. I would also check whether the secret is exposed in manifests, CI logs, or container images.",
    followUps: [
      "What does encryption at rest protect against?",
      "How would you rotate the credential?",
      "Why are Secrets in a namespace not a security boundary by themselves?",
    ],
    redFlags: [
      "Calls base64 encryption.",
      "Relies on the Secret type for access control.",
      "Ignores etcd and manifest exposure.",
    ],
    rubric: [
      "Distinguishes encoding from encryption.",
      "Names access control and encryption at rest.",
      "Considers rotation and exposure.",
      "Scopes the protection correctly.",
    ],
  },
  {
    id: "reload-design",
    question:
      "You want configuration changes to reach pods without a full Deployment restart. What would you build, and what new failure modes does it add?",
    difficulty: 3,
    hints: [
      "A volume mount gives you a file, not a notification.",
      "Reload logic must handle partial writes and repeated events.",
    ],
    answer:
      "I would mount the object as a volume and have the application watch the file, or run a reloader that watches the object and signals the process. The new failure modes are partial or delayed file refreshes, duplicate reload events, a process that rereads only part of its configuration, and a reloader that fails silently. I would add a config revision metric, validate the parsed configuration before applying it, and keep a rollout path for changes that cannot be applied in place.",
    followUps: [
      "How would you avoid a reload loop?",
      "What would you do if the new configuration is invalid?",
      "When is a rollout still the safer option?",
    ],
    redFlags: [
      "Assumes a file watch is atomic.",
      "Applies config without validation.",
      "Removes the rollout path entirely.",
    ],
    rubric: [
      "Names a concrete delivery mechanism.",
      "Accounts for partial refresh and invalid config.",
      "Adds observability and a fallback.",
      "States the tradeoff.",
    ],
  },
];

const checklist = [
  {
    title: "Before the change",
    items: [
      "Every workload declares how it consumes ConfigMaps and Secrets.",
      "A config change has a rollout or reload path, not just an object edit.",
      "Secret read access is scoped and encryption at rest is configured where required.",
      "The pod template or a checksum annotation makes config changes visible to the Deployment.",
    ],
  },
  {
    title: "During the change",
    items: [
      "Compare the object update time with pod start times.",
      "Check the effective value inside a pod, not only the API object.",
      "Watch the rollout status and the count of pods on the old revision.",
      "Check whether a mounted file changed but the process did not reload it.",
    ],
  },
  {
    title: "After the change",
    items: [
      "Confirm every replica reports the new revision.",
      "Record whether the change needed a restart and how long convergence took.",
      "Review Secret exposure and rotate any credential that was handled insecurely.",
      "Add an alert for pods older than the configuration revision they should use.",
    ],
  },
];

const references = [
  {
    title: "ConfigMaps",
    url: "https://kubernetes.io/docs/concepts/configuration/configmap/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Consumption as environment variables or volume files, and the update behavior of each.",
  },
  {
    title: "Secrets",
    url: "https://kubernetes.io/docs/concepts/configuration/secret/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Secret types, base64 encoding, mounted Secrets, and information security notes.",
  },
  {
    title: "Encrypting data at rest",
    url: "https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Configuring an encryption provider for Secret data stored in etcd.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "config-secrets": {
      model: configSecretsModel,
      presets,
      instructions:
        "Start Healthy, then switch to environment injection without restarting pods. Watch the stale share, then roll the pods or enable a volume reload. Compare the two paths.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Eight pods, a 40 ms baseline latency, and a 25% stale-config critical line are teaching values; kubelet sync timing depends on the cluster.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["containers-secrets", "deployment-config-drift", "kubernetes-rbac"],
};
