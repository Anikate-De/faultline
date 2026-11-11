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

const params: ParamSpec[] = [
  {
    id: "desiredReplicas",
    label: "Desired pods",
    min: 2,
    max: 12,
    step: 1,
    value: 6,
    unit: " pods",
    group: "Deployment",
    help: "The replica count in the Deployment spec. It is the number of pods the controller tries to keep available, not the number that happens to be running.",
    format: "count",
  },
  {
    id: "maxSurgePercent",
    label: "maxSurge",
    min: 0,
    max: 50,
    step: 5,
    value: 0,
    unit: "%",
    group: "Rollout",
    help: "Extra pods the Deployment may create above the desired count. Kubernetes rounds the count up. The value is illustrative and applies to this rollout snapshot.",
    format: "percent",
  },
  {
    id: "maxUnavailablePercent",
    label: "maxUnavailable",
    min: 0,
    max: 50,
    step: 5,
    value: 25,
    unit: "%",
    group: "Rollout",
    help: "Pods that may be unavailable while old pods are replaced. Kubernetes rounds the count down. An explicit maxSurge=0 with maxUnavailable=0 is rejected; only an omitted field defaults to 25%.",
    format: "percent",
  },
  {
    id: "readinessFailurePercent",
    label: "New pods failing readiness",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Readiness",
    help: "Share of new pods that never pass their readiness probe for this revision, for example because the image cannot reach its dependency.",
    format: "percent",
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
  desired: number;
  surge: number;
  unavailable: number;
  newPods: number;
  newReady: number;
  unreadyNew: number;
  oldReady: number;
  ready: number;
  gap: number;
  progress: number;
  stalled: boolean;
  invalidStrategy: boolean;
  readinessFailure: number;
}

function compute(p: Params): Values {
  const desired = Math.round(clamp(num(p, "desiredReplicas", 6), 2, 12));
  const surgePercent = clamp(num(p, "maxSurgePercent", 0), 0, 50);
  const unavailablePercent = clamp(num(p, "maxUnavailablePercent", 25), 0, 50);
  const readinessFailure = clamp(num(p, "readinessFailurePercent", 0), 0, 100);
  const invalidStrategy = surgePercent === 0 && unavailablePercent === 0;
  const surge = Math.ceil((desired * surgePercent) / 100);
  const unavailable = Math.floor((desired * unavailablePercent) / 100);
  const newPods = surge + unavailable;
  const unreadyNew = Math.min(newPods, Math.round((newPods * readinessFailure) / 100));
  const newReady = newPods - unreadyNew;
  const oldReady = Math.max(0, desired - unavailable);
  const ready = oldReady + newReady;
  const gap = desired > 0 ? Math.max(0, ((desired - Math.min(desired, ready)) / desired) * 100) : 0;
  const progress = newPods > 0 ? (newReady / newPods) * 100 : 0;
  return {
    desired,
    surge,
    unavailable,
    newPods,
    newReady,
    unreadyNew,
    oldReady,
    ready,
    gap,
    progress,
    stalled: newPods === 0 || (newReady === 0 && readinessFailure > 0),
    invalidStrategy,
    readinessFailure,
  };
}

function gapHealth(gap: number): Health {
  if (gap >= 25) return "crit";
  if (gap >= 10) return "warn";
  return "ok";
}

function canaryHealth(values: Values): Health {
  if (values.newPods === 0) return "crit";
  if (values.unreadyNew === 0) return "ok";
  return values.newReady === 0 ? "crit" : "warn";
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function buildFrame(values: Values, seed: number): SimFrame {
  const readiness = gapHealth(values.gap);
  const oldDesired = Math.max(1, values.desired - values.unavailable);
  const stableGap =
    oldDesired > 0 ? ((oldDesired - Math.min(oldDesired, values.oldReady)) / oldDesired) * 100 : 0;
  const stable = gapHealth(stableGap);
  const canary = canaryHealth(values);
  const rollout: Health = values.stalled ? "crit" : readiness;
  const full = values.stalled ? "crit" : readiness;
  const strategy = values.invalidStrategy
    ? "Invalid strategy: maxSurge and maxUnavailable are both 0."
    : values.newPods === 0
      ? "No replacement pod can start because the rounded maxSurge and maxUnavailable are both 0."
      : `${values.newPods} replacement pods started; ${values.unreadyNew} are not Ready.`;
  return {
    t: 0,
    nodes: [
      {
        id: "old-replicaset",
        label: "Old ReplicaSet",
        kind: "service",
        health: stable,
        utilization: clamp(values.oldReady / values.desired),
        sublabel: `${values.oldReady} old pods ready`,
        detail: `The previous ReplicaSet still owns ${values.oldReady} Ready pods. maxUnavailable allowed ${values.unavailable} of them to be removed before replacements were Ready.`,
        meta: { stage: "stable" },
      },
      {
        id: "new-replicaset",
        label: "New ReplicaSet",
        kind: "service",
        health: canary,
        utilization: clamp(values.progress / 100),
        sublabel: values.invalidStrategy
          ? "invalid strategy: 0/0"
          : values.newPods === 0
            ? "no replacement slot"
            : `${values.newReady} ready / ${values.newPods} started`,
        detail: `The new revision has ${values.newPods} pods in this snapshot. ${strategy}`,
        meta: { stage: "canary" },
      },
      {
        id: "deployment",
        label: "Deployment: api",
        kind: "service",
        health: full,
        utilization: clamp(Math.min(values.ready, values.desired) / values.desired),
        sublabel: `${Math.min(values.ready, values.desired)}/${values.desired} available`,
        detail: `The Deployment owns both ReplicaSets and keeps revision history for rollback. Its status reports available replicas, not merely running pods.`,
        meta: { stage: "full" },
      },
    ],
    edges: [
      edge(
        "old-new",
        "old-replicaset",
        "new-replicaset",
        clamp(values.oldReady / values.desired),
        worst(stable, canary),
        "replaced by",
      ),
      edge(
        "new-full",
        "new-replicaset",
        "deployment",
        clamp(values.progress / 100),
        worst(canary, rollout),
        "available",
      ),
    ],
    metrics: [
      metric("ready-pods", "Ready pods", values.ready, " pods", undefined, undefined, "count"),
      metric("readiness-gap", "Readiness gap", values.gap, "%", 10, 25, "percent"),
      metric(
        "unready-pods",
        "Unready new pods",
        values.unreadyNew,
        " pods",
        undefined,
        undefined,
        "count",
      ),
      metric(
        "rollout-progress",
        "New pods ready",
        values.progress,
        "%",
        undefined,
        undefined,
        "percent",
      ),
      metric("rollout-stalled", "Rollout stalled", values.stalled ? 1 : 0, "", 0.5, 1, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      ready: values.ready,
      gap: values.gap,
      stalled: values.stalled,
      invalidStrategy: values.invalidStrategy,
    },
    summary: values.invalidStrategy
      ? `Invalid rollout strategy: maxSurge and maxUnavailable are both 0. ${Math.min(values.ready, values.desired)}/${values.desired} pods available, but the revision cannot progress.`
      : values.newPods === 0
        ? `Rounded maxSurge and maxUnavailable are both 0, so no replacement pod can start. ${Math.min(values.ready, values.desired)}/${values.desired} pods available; rollout stalled.`
        : `${Math.min(values.ready, values.desired)}/${values.desired} desired pods available. ${values.unreadyNew} new pods unready; rollout ${values.stalled ? "stalled" : "progressing"}.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = 0.015 * Math.sin((index + (seed % 5)) / 3.2);
      return Math.max(0, item.value * (1 + wave));
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "readiness-gap",
    metricId: "readiness-gap",
    warn: 10,
    crit: 25,
    title: "Ready capacity is below the desired replica count",
    cause:
      "The rollout removed old pods up to maxUnavailable, but the new pods have not passed readiness. A running pod is not a Ready pod; until the readiness probe succeeds, the Deployment does not count it as available.",
    fix: "Fix the readiness failure first, then reduce maxUnavailable or add maxSurge so replacements start before old pods are removed. Check the ReplicaSet events and the new pod's readiness probe output.",
    checkFirst: [
      "Compare desired, updated, ready, and available counts in kubectl get deployment.",
      "Read kubectl rollout status and the ReplicaSet events for the new revision.",
      "Describe a new pod and check its readiness probe result and container state.",
    ],
  },
  {
    id: "rollout-stalled",
    metricId: "rollout-stalled",
    warn: 0.5,
    crit: 1,
    title: "The rollout cannot make progress",
    cause:
      "No replacement pod can start because the rounded maxSurge and maxUnavailable are both zero, the strategy is an invalid 0/0 pair, or every started pod fails readiness. The Deployment cannot remove more old pods until a replacement is available, so the revision stays in progress.",
    fix: "Set at least one of maxSurge or maxUnavailable above the rounding threshold; do not set both to zero. If replacements exist but are unready, fix the readiness failure and roll forward. If the old revision is healthy, a rollback restores the last known-good ReplicaSet.",
    checkFirst: [
      "Check kubectl rollout status and the Deployment strategy, including rounding.",
      "Compare the new and old ReplicaSet pod counts and readiness.",
      "Check kubectl rollout history before choosing rollback or fix-forward.",
    ],
  },
];

export const podsDeploymentsModel: SimModel = {
  id: "pods-deployments",
  visual: "deployment",
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
      `Desired ${values.desired}. This snapshot starts ${values.newPods} new pods and keeps ${values.oldReady} old pods Ready. maxSurge allowed ${values.surge} extra pods and maxUnavailable allowed ${values.unavailable} old pods to leave first.`,
      `Ready capacity is ${Math.min(values.ready, values.desired)} of ${values.desired}. ${values.unreadyNew} new pods are running but not Ready, so they do not receive Service traffic and do not count as available.`,
    ];
    if (values.invalidStrategy) {
      items.push(
        "The strategy is invalid: maxSurge and maxUnavailable are both 0. Kubernetes rejects that explicit pair, and this model shows the resulting blocked rollout. Omitted fields default to 25%; explicit zeroes do not.",
      );
    } else if (values.newPods === 0) {
      items.push(
        "The rounded maxSurge and maxUnavailable are both zero, so no replacement pod can start. This is a rounding trap, not a readiness failure: six desired pods with 5% maxUnavailable rounds down to zero.",
      );
    } else if (values.stalled) {
      items.push(
        "The rollout is stalled because no new pod is Ready. The controller waits instead of removing more old pods, which protects availability but leaves the revision unfinished.",
      );
    } else if (values.gap > 0) {
      items.push(
        "Some replacements are Ready, so the rollout advances. The gap remains because the unavailable allowance is larger than the number of Ready replacements.",
      );
    } else {
      items.push(
        "Ready capacity covers the desired count. Surge pods can be Ready at the same time, which is why the Ready count may exceed the desired replica count during a rollout.",
      );
    }
    items.push(
      "The Deployment object records revision history and rollout status, but it does not decide readiness. The kubelet runs the probe; the Deployment controller only counts the result.",
    );
    return items;
  },
  legend: [
    { label: "Ready", tone: "ok" },
    { label: "Partially ready", tone: "warn" },
    { label: "Not ready or stalled", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy rollout",
    description:
      "Six desired pods, no surge, 25% maxUnavailable, and every new pod passes readiness.",
    tone: "ok",
    params: defaults({
      desiredReplicas: 6,
      maxSurgePercent: 0,
      maxUnavailablePercent: 25,
      readinessFailurePercent: 0,
    }),
  },
  {
    id: "peak",
    label: "Partial readiness failure",
    description:
      "Half the old pods are replaced at once and 30% of new pods fail readiness. Ready capacity dips.",
    tone: "warn",
    params: defaults({
      desiredReplicas: 6,
      maxSurgePercent: 0,
      maxUnavailablePercent: 50,
      readinessFailurePercent: 30,
    }),
  },
  {
    id: "failure",
    label: "Readiness blocks the rollout",
    description:
      "Six desired, 50% maxUnavailable, and every new pod fails readiness. Only three old pods remain available.",
    tone: "crit",
    params: defaults({
      desiredReplicas: 6,
      maxSurgePercent: 0,
      maxUnavailablePercent: 50,
      readinessFailurePercent: 100,
    }),
  },
  {
    id: "stalled-safe",
    label: "Stalled but serving",
    description:
      "Surge starts two new pods before any old pod leaves, but both fail readiness. Availability holds while the rollout stalls.",
    tone: "crit",
    params: defaults({
      desiredReplicas: 6,
      maxSurgePercent: 25,
      maxUnavailablePercent: 0,
      readinessFailurePercent: 100,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "The readiness defect is fixed. Surge plus zero maxUnavailable keeps six old pods Ready while two replacements start.",
    tone: "ok",
    params: defaults({
      desiredReplicas: 6,
      maxSurgePercent: 25,
      maxUnavailablePercent: 0,
      readinessFailurePercent: 0,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-readiness-gap",
  title: "Predict why only three of six pods are available",
  simId: "pods-deployments",
  question:
    "A Deployment wants six pods. It uses maxSurge 0 and maxUnavailable 50%. The new revision starts three pods, but none passes readiness. How many pods are available?",
  prediction: {
    options: [
      { id: "six", label: "Six. The old pods stay until the new ones are Ready" },
      {
        id: "three",
        label: "Three. The controller removed three old pods and no replacement is Ready",
      },
      { id: "nine", label: "Nine. The Deployment keeps old and new pods running" },
      { id: "zero", label: "Zero. A failed rollout takes the whole Deployment down" },
    ],
    correctOptionId: "three",
    explanation:
      "maxUnavailable lets the controller remove up to three of the six old pods before replacements are Ready. With maxSurge at zero there are no extra pods, and all three new pods fail readiness. The old ReplicaSet keeps the remaining three Ready, so availability is three of six.",
  },
  setup: defaults({
    desiredReplicas: 6,
    maxSurgePercent: 0,
    maxUnavailablePercent: 50,
    readinessFailurePercent: 100,
  }),
  runFor: 20,
  observe: [
    "Ready capacity falls to three pods, a 50% readiness gap.",
    "The new ReplicaSet has three running pods but zero Ready pods.",
    "The rollout is marked stalled while the old ReplicaSet keeps serving.",
    "The Deployment does not roll back automatically; the last known-good revision is still available for a manual rollback.",
  ],
  explain:
    "A Deployment performs a rolling update by owning two ReplicaSets. It can remove old pods up to the maxUnavailable allowance, but it will not remove more until replacements become Ready. Readiness is the gate between a running container and an available replica. When readiness fails across the new revision, the allowance becomes an availability loss with no progress.",
  fix: defaults({
    desiredReplicas: 6,
    maxSurgePercent: 25,
    maxUnavailablePercent: 0,
    readinessFailurePercent: 0,
  }),
  debrief:
    "With maxUnavailable at zero and 25% surge, the controller starts replacements before removing old pods. Once readiness passes, old pods leave one at a time and availability is never below the desired count. The tradeoff is temporary extra pods and a slower rollout. Surge cannot rescue a revision that never becomes Ready; it only protects availability while you diagnose it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Pod is the smallest schedulable unit in Kubernetes: one or more containers that share a network namespace and volumes. A Deployment is a controller that owns one or more ReplicaSets, and each ReplicaSet owns a set of Pods. You describe the desired replica count and a pod template; the Deployment controller moves the ReplicaSets toward that state.",
  },
  {
    type: "p",
    text: "A rolling update creates a new ReplicaSet for the new pod template and scales it up while scaling the old one down. Two settings bound the transition. maxSurge is how many extra pods may exist above the desired count. maxUnavailable is how many pods may be unavailable during the transition. Kubernetes rounds maxSurge up and maxUnavailable down. An omitted field defaults to 25%; an explicit maxSurge=0 with maxUnavailable=0 is rejected.",
  },
  {
    type: "table",
    headers: ["Object", "Owns", "What it tells you", "What it does not prove"],
    rows: [
      [
        "Deployment",
        "ReplicaSets and revision history",
        "Desired state, rollout status, available replicas",
        "That a running pod can serve traffic",
      ],
      [
        "ReplicaSet",
        "A fixed pod template and replica count",
        "How many pods of one revision exist",
        "That the pods pass readiness",
      ],
      [
        "Pod",
        "Containers and volumes",
        "Container state, restarts, probe results",
        "That the Service selects or routes to it",
      ],
      [
        "Readiness probe",
        "Per-container health signal",
        "Whether the pod can receive traffic",
        "That the application is fast or correct",
      ],
    ],
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The Deployment controller runs in the control plane. It creates and scales ReplicaSets, then the scheduler places pods on nodes and the kubelet runs the containers. Readiness is evaluated by the kubelet and reported in pod status. EndpointSlice controllers watch that status and publish only Ready pods as Service endpoints. A pod can therefore be running, have a healthy container, and still be absent from the traffic path.",
  },
  {
    type: "p",
    text: "This module models a rollout snapshot, not wall-clock progression. The percentages and pod counts are illustrative teaching values. Watch three numbers: how many old pods leave, how many new pods become Ready, and how much of the desired count is still available. A rollout that is not progressing is different from one that is progressing but below capacity.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Ready pods: the total the Deployment can count as available, including Ready surge pods.",
      "Readiness gap: desired replicas minus available replicas, as a share of desired.",
      "Unready new pods: containers that are running but have not passed readiness.",
      "Rollout progress: the share of new pods that are Ready in this snapshot.",
      "Rollout stalled: whether the controller can advance the new ReplicaSet at all.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Partial readiness failure to see a warning-sized gap. Apply Readiness blocks the rollout to watch maxUnavailable turn into lost availability. Compare Stalled but serving: surge protects availability, but the revision still cannot finish. Run the experiment before revealing the explanation, then apply Recovery.",
  },
  {
    type: "p",
    text: "The production question is not how many pods exist. It is how many pods are Ready, how many the Deployment believes are available, and which revision owns them. Those three answers usually separate a capacity problem from a readiness problem and a stalled rollout from a rolling one.",
  },
  { type: "sim", simId: "pods-deployments" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset removed three old pods under the 50% maxUnavailable allowance and started three replacements. None passed readiness, so the Deployment counted zero new available pods. The old ReplicaSet kept the remaining three pods serving, which is why the outage was partial rather than total. The rollout showed as stalled because the controller would not remove more old pods without a Ready replacement.",
  },
  {
    type: "p",
    text: "The recovery preset switched the allowance: maxUnavailable went to zero and 25% surge started two replacements before any old pod left. With readiness fixed, replacements became available and the old ReplicaSet could scale down. The stalled-but-serving preset showed that surge can protect availability without making a bad revision deployable.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Deployment status: desired, updated, ready, available, and unavailable replica counts.",
      "ReplicaSet status for the old and new revisions, including pod counts and conditions.",
      "Pod status and events for readiness probe failures, image pulls, and restarts.",
      "EndpointSlice membership, which shows whether Ready pods are actually receiving traffic.",
      "Rollout history and change cause annotations, which identify what revision is being rolled out.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Run kubectl rollout status and kubectl get deployment to compare desired, updated, ready, and available. If the new ReplicaSet has running pods but no Ready pods, describe one and read the readiness probe result first. If the rollout is stalled, check kubectl rollout history before choosing rollback or fix-forward.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm whether the gap is readiness, scheduling, image pull, or a configuration error.",
      "Fix the readiness failure in the new revision; do not lower the probe until it passes by accident.",
      "Use maxSurge above zero and maxUnavailable at zero when availability must not dip.",
      "Pause or roll back if the revision cannot become Ready within the rollout budget.",
      "Verify EndpointSlice membership and Service traffic after the rollout completes.",
      "Record the revision and change cause so the next responder knows what changed.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Surge protects availability and temporarily consumes extra node capacity and cost.",
      "A high maxUnavailable speeds the rollout and increases the availability dip when readiness fails.",
      "maxUnavailable at zero with no surge can stall the rollout because no slot exists to start a replacement.",
      "An explicit 0/0 strategy is invalid; keep at least one control above the rounding threshold.",
      "A readiness probe that checks dependencies is stricter and can remove healthy pods during a dependency outage.",
      "Keeping more revision history helps rollback and consumes etcd storage and object count.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "four-of-six-ready",
    question:
      "A Deployment says six replicas but only four pods are Ready. Walk me through your first five minutes.",
    difficulty: 2,
    hints: [
      "Running and Ready are different fields.",
      "Compare the old and new ReplicaSets before reading application logs.",
    ],
    answer:
      "I would start with kubectl get deployment and kubectl rollout status, then compare desired, updated, ready, and available. Next I would list both ReplicaSets with their pod counts and readiness, because a partial rollout often leaves the old revision serving while the new one is stuck. I would describe an unready pod to see whether it is Pending, crashing, or failing its readiness probe, and check EndpointSlice membership to confirm traffic impact. Only after those checks would I read application logs. The fix depends on whether the problem is placement, image pull, container crash, or readiness logic.",
    followUps: [
      "How would the answer change if the new ReplicaSet had zero pods?",
      "What does the available count include that ready does not?",
      "When would you roll back instead of fixing forward?",
    ],
    redFlags: [
      "Counts running pods as available.",
      "Reads application logs before checking pod state and events.",
      "Raises maxUnavailable to make the rollout finish.",
    ],
    rubric: [
      "Separates running, Ready, and available.",
      "Inspects both ReplicaSets.",
      "Checks pod events and probe results.",
      "Chooses rollback or fix-forward from evidence.",
    ],
  },
  {
    id: "rollout-strategy",
    question:
      "How do maxSurge and maxUnavailable interact, and how would you choose them for a latency-sensitive service?",
    difficulty: 2,
    hints: [
      "Availability during the rollout is bounded by maxUnavailable, not by the desired count.",
      "Surge needs node capacity; zero surge needs a free pod slot.",
    ],
    answer:
      "maxSurge creates replacements before old pods leave; maxUnavailable permits old pods to leave before replacements are Ready. For a latency-sensitive service I would keep maxUnavailable at zero and use a modest surge, provided the cluster has capacity for the extra pods. That keeps serving capacity at or above the desired count throughout the rollout. If surge cannot be scheduled, the rollout stalls, so I would also check node headroom and PodDisruptionBudgets. An explicit 0/0 pair is rejected; if rounding makes both counts zero, the rollout also stalls even though the percentages are not zero. For a batch service I might accept some unavailability to reduce temporary cost and rollout time.",
    followUps: [
      "What happens when both values are zero?",
      "How does a PodDisruptionBudget differ from maxUnavailable?",
      "How would you verify the rollout did not breach the latency SLO?",
    ],
    redFlags: [
      "Treats the desired count as the rollout floor.",
      "Sets both values high to make the rollout fast.",
      "Ignores cluster capacity for surge pods.",
    ],
    rubric: [
      "Explains both controls accurately.",
      "Connects the choice to availability and capacity.",
      "Mentions scheduling and cost.",
      "Defines a verification signal.",
    ],
  },
  {
    id: "stalled-rollout",
    question:
      "A rollout has been in progress for 15 minutes and the old ReplicaSet is still serving. What could be blocking it, and how do you distinguish the causes?",
    difficulty: 3,
    hints: [
      "A stalled controller and an unhealthy new pod look similar in the Deployment summary.",
      "ReplicaSet events and pod conditions carry the detail.",
    ],
    answer:
      "I would check whether the new ReplicaSet has created pods at all. If it has none, the controller may be blocked by quota, a missing service account, or an admission webhook. If pods are Pending, the scheduler cannot place them because of requests, affinity, taints, or node capacity. If pods are running but not Ready, the readiness probe or the application is failing. If the new ReplicaSet is scaling but old pods are not leaving, maxUnavailable or a PodDisruptionBudget may be blocking progress. The Deployment condition and ReplicaSet events usually say which stage is stuck; the fix is different for each.",
    followUps: [
      "How would a ResourceQuota show up in this investigation?",
      "What does the Progressing condition tell you?",
      "What would you check before increasing the rollout timeout?",
    ],
    redFlags: [
      "Assumes the new image is broken before checking scheduling.",
      "Increases the timeout without finding the blocker.",
      "Ignores ReplicaSet events.",
    ],
    rubric: [
      "Checks pod creation, scheduling, and readiness separately.",
      "Reads Deployment and ReplicaSet conditions.",
      "Considers quota and admission control.",
      "Picks a targeted fix.",
    ],
  },
];

const checklist = [
  {
    title: "Before the rollout",
    items: [
      "Confirm the Deployment's readiness probe reflects the ability to serve traffic.",
      "Calculate the worst-case availability from maxSurge and maxUnavailable.",
      "Confirm the cluster has capacity for surge pods.",
      "Record the current revision and change cause for rollback.",
      "Check that a PodDisruptionBudget does not block the intended rollout.",
    ],
  },
  {
    title: "During the rollout",
    items: [
      "Watch ready and available replicas, not only running pods.",
      "Compare old and new ReplicaSet pod counts.",
      "Read pod events and readiness probe failures for the new revision.",
      "Check EndpointSlice membership to confirm traffic impact.",
      "Decide early whether to roll back or fix forward.",
    ],
  },
  {
    title: "After the rollout",
    items: [
      "Confirm the new ReplicaSet is fully available and the old one is scaled down.",
      "Verify the Service has the expected Ready endpoints.",
      "Review whether the rollout stayed inside the availability target.",
      "Keep enough revision history for the next rollback.",
    ],
  },
];

const references = [
  {
    title: "Deployments",
    url: "https://kubernetes.io/docs/concepts/workloads/controllers/deployment/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Deployment ownership, rolling updates, maxSurge, maxUnavailable, and revision history.",
  },
  {
    title: "kubectl rollout",
    url: "https://kubernetes.io/docs/reference/kubectl/generated/kubectl_rollout/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Status, history, pause, resume, restart, and undo commands for a rollout.",
  },
  {
    title: "ReplicaSets",
    url: "https://kubernetes.io/docs/concepts/workloads/controllers/replicaset/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "How a ReplicaSet maintains a stable set of running pods.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "pods-deployments": {
      model: podsDeploymentsModel,
      presets,
      instructions:
        "Start Healthy, then apply Partial readiness failure and Readiness blocks the rollout. Compare the old and new ReplicaSet counts. Apply Stalled but serving to see surge protect availability, then run the experiment and apply Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Pod counts, readiness percentages, and the rollout snapshot are teaching values; Kubernetes rounding and the rejection of an explicit 0/0 strategy follow the Deployment documentation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "kubernetes-services-networking",
    "kubernetes-probes",
    "deployment-rolling",
    "containers-rolling-deployments",
  ],
};
