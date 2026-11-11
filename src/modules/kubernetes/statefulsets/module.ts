import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "replicas",
    label: "StatefulSet replicas",
    min: 1,
    max: 5,
    step: 1,
    value: 3,
    unit: " pods",
    group: "Workload",
    help: "Ordinal pods, from pod-0 to pod-(n-1). Each ordinal gets its own identity and, with volumeClaimTemplates, its own claim.",
    format: "count",
  },
  {
    id: "storageMode",
    label: "Pod storage",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Storage",
    help: "0 is volumeClaimTemplates, 1 is emptyDir, 2 is hostPath. Only volumeClaimTemplates gives each ordinal a claim that follows the pod.",
    format: "count",
  },
  {
    id: "deletePvc",
    label: "Delete claim on recreation",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Storage",
    help: "1 removes the ordinal's PVC before the pod is recreated, so the new pod binds an empty claim. A StatefulSet does not delete its PVCs by default.",
    format: "count",
  },
  {
    id: "disruption",
    label: "Disruption",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "0 is none, 1 is a pod restart, 2 is a node failure and reschedule, 3 is a full node pool replacement that recreates every ordinal.",
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

interface Computed {
  replicas: number;
  storageMode: number;
  deletePvc: number;
  disruption: number;
  affected: number;
  lost: number;
  atRisk: number;
  available: number;
  boundClaims: number;
  availability: number;
}

function compute(p: Params): Computed {
  const replicas = Math.round(clamp(num(p, "replicas", 3), 1, 5));
  const storageMode = Math.round(clamp(num(p, "storageMode", 0), 0, 2));
  const deletePvc = Math.round(clamp(num(p, "deletePvc", 0), 0, 1));
  const disruption = Math.round(clamp(num(p, "disruption", 0), 0, 3));
  const affected = disruption === 0 ? 0 : disruption === 3 ? replicas : 1;
  const stableClaim = storageMode === 0 && deletePvc === 0;
  let lost = 0;
  if (!stableClaim) {
    if (storageMode === 1) lost = affected;
    else if (storageMode === 2) lost = disruption >= 2 ? affected : 0;
    else lost = deletePvc === 1 ? affected : 0;
  }
  const atRisk = storageMode === 0 ? (deletePvc === 1 ? Math.max(1, affected) : 0) : replicas;
  const available = replicas - (disruption === 3 ? replicas : affected);
  const boundClaims = storageMode === 0 ? replicas - (deletePvc === 1 ? affected : 0) : 0;
  return {
    replicas,
    storageMode,
    deletePvc,
    disruption,
    affected,
    lost,
    atRisk,
    available,
    boundClaims,
    availability: (available / replicas) * 100,
  };
}

function healthFor(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function worst(values: Health[]): Health {
  const rank: Record<Health, number> = { ok: 0, warn: 1, crit: 2, down: 3 };
  return values.reduce<Health>((best, value) => (rank[value] > rank[best] ? value : best), "ok");
}

function storageLabel(mode: number): string {
  if (mode === 1) return "emptyDir";
  if (mode === 2) return "hostPath";
  return "volumeClaimTemplates";
}

function buildFrame(values: Computed, seed: number): SimFrame {
  const lostHealth = healthFor(values.lost, 1, 2);
  const riskHealth = healthFor(values.atRisk, 1, 3);
  const workloadHealth = worst([lostHealth, riskHealth]);
  const downOrdinals = new Set<number>();
  if (values.disruption === 3) {
    for (let index = 0; index < values.replicas; index++) downOrdinals.add(index);
  } else if (values.affected > 0) {
    downOrdinals.add(values.replicas - 1);
  }
  const podNodes: SimNode[] = Array.from({ length: values.replicas }, (_, index) => {
    const down = downOrdinals.has(index);
    const claimLost = down && values.lost > 0;
    return {
      id: `pod-${index}`,
      label: `pod-${index}`,
      kind: "service",
      role: "instance",
      health: down ? "down" : values.atRisk > 0 && values.storageMode !== 0 ? "warn" : "ok",
      sublabel: claimLost
        ? `Pod unavailable · volume data lost`
        : down
          ? `Pod unavailable · claim reattaching`
          : values.storageMode === 0
            ? `ordinal ${index} · data-pod-${index}`
            : `ordinal ${index} · ${storageLabel(values.storageMode)}`,
      detail: claimLost
        ? `Pod unavailable: the pod was recreated and bound a new, empty volume. The ordinal name is stable, but the data path was not.`
        : down
          ? `Pod unavailable while the pod is recreated at ordinal ${index}. A stable claim should reattach to the same ordinal if the claim still exists.`
          : `Ordinal ${index} keeps its name and, with volumeClaimTemplates, its own claim across rescheduling.`,
      meta: { view: "flow", ordinal: index, lost: claimLost ? 1 : 0 },
    };
  });
  return {
    t: 0,
    nodes: [
      {
        id: "statefulset",
        label: "StatefulSet",
        kind: "service",
        health: workloadHealth,
        utilization: clamp(values.availability / 100),
        sublabel: `${values.available} of ${values.replicas} ordinals available`,
        detail: `The controller creates ordinals in order. It does not delete PVCs when a pod is recreated, scaled down, or when the StatefulSet itself is deleted.`,
        meta: { view: "flow" },
      },
      {
        id: "headless",
        label: "headless Service",
        kind: "service",
        health: "ok",
        sublabel: "clusterIP: None",
        detail: "DNS returns the pod endpoints and each ordinal gets a stable name. The Service object is independent of the volume path: its health does not prove the data is intact.",
        meta: { view: "flow" },
      },
      ...podNodes,
      {
        id: "volume",
        label: storageLabel(values.storageMode),
        kind: "storage",
        health: riskHealth,
        utilization: values.replicas > 0 ? clamp(values.boundClaims / values.replicas) : 0,
        sublabel: `${values.boundClaims} of ${values.replicas} claims bound`,
        detail:
          values.storageMode === 0
            ? "Each ordinal has a claim named from the template and the pod. The claim is stable; deleting it is what removes the data, not deleting the pod."
            : values.storageMode === 1
              ? "emptyDir is deleted with the pod. The volume data is lost after a restart or reschedule; there is no claim to reattach."
              : "hostPath ties data to a node path. It is not portable when the pod moves to another node.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      ...podNodes.map((pod, index) =>
        edge(`sts-pod-${index}`, "statefulset", pod.id, clamp(1 / values.replicas), workloadHealth),
      ),
      ...podNodes.map((pod, index) =>
        edge(`headless-pod-${index}`, "headless", pod.id, clamp(1 / values.replicas), lostHealth),
      ),
      ...podNodes.map((pod, index) =>
        edge(
          `pod-volume-${index}`,
          pod.id,
          "volume",
          values.boundClaims > 0 ? clamp(1 / values.boundClaims) : 0,
          riskHealth,
        ),
      ),
    ],
    metrics: [
      metric("lost-ordinals", "Ordinals with lost data", values.lost, "", 1, 2, "count"),
      metric("pods-at-risk", "Ordinals without a stable claim", values.atRisk, "", 1, 3, "count"),
      metric("available-ordinals", "Available ordinals", values.available, "", undefined, undefined, "count"),
      metric("ordinal-availability", "Ordinal availability", values.availability, "%", undefined, undefined, "percent"),
      metric("bound-claims", "Bound claims", values.boundClaims, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, storageMode: values.storageMode, disruption: values.disruption },
    summary: `${values.available} of ${values.replicas} ordinals available; ${values.lost} lost data; ${values.boundClaims} claims bound to ${storageLabel(values.storageMode)}.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 4)) / 2.5);
  const entries: [string, number, number][] = [
    ["lost-ordinals", values.lost, 0],
    ["pods-at-risk", values.atRisk, 0],
    ["available-ordinals", values.available, 0],
    ["ordinal-availability", values.availability, 0.2],
    ["bound-claims", values.boundClaims, 0],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.4) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "lost-ordinals",
    metricId: "lost-ordinals",
    warn: 1,
    crit: 2,
    title: "An ordinal was recreated without its data",
    cause:
      "The pod lost its volume because the claim was not stable. A missing volumeClaimTemplates, an emptyDir, a hostPath tied to the old node, or a deleted PVC all produce the same result: the ordinal name survives and the data does not.",
    fix:
      "Move persistent data to volumeClaimTemplates and verify each ordinal binds its own claim. Stop deleting PVCs during pod recreation. If a claim must be replaced, restore data before the pod starts, not after it serves traffic.",
    checkFirst: [
      "Compare the StatefulSet spec's volumeClaimTemplates with the pod's mounted volumes.",
      "Check whether the PVC still exists and is bound for the affected ordinal.",
      "Check the pod events for volume attach or mount errors before the restart.",
    ],
  },
  {
    id: "pods-at-risk",
    metricId: "pods-at-risk",
    warn: 1,
    crit: 3,
    title: "The workload has no stable claim to reattach",
    cause:
      "emptyDir and hostPath do not provide a portable claim per ordinal. A StatefulSet gives stable identity, but it cannot make a non-persistent volume persistent. The risk applies to every ordinal even before the next disruption.",
    fix:
      "Define volumeClaimTemplates with a storage class that supports the access mode and durability the workload needs. Verify the binding and the reclaim policy, then test a pod deletion and a node reschedule before trusting the design.",
    checkFirst: [
      "Read the StatefulSet storage section and the storage class parameters.",
      "Check whether the PVCs exist and are bound, not only whether the pods are running.",
      "Check the reclaim policy and whether a scale-down or deletion would remove the claims.",
    ],
  },
];

function defaultsFor(id: string): Params {
  if (id === "peak") {
    return defaults({ replicas: 3, storageMode: 0, deletePvc: 1, disruption: 1 });
  }
  if (id === "failure") {
    return defaults({ replicas: 3, storageMode: 1, deletePvc: 0, disruption: 3 });
  }
  if (id === "reattach") {
    return defaults({ replicas: 3, storageMode: 0, deletePvc: 0, disruption: 2 });
  }
  if (id === "recovery") {
    return defaults({ replicas: 5, storageMode: 0, deletePvc: 0, disruption: 0 });
  }
  return defaults({ replicas: 3, storageMode: 0, deletePvc: 0, disruption: 0 });
}

export const statefulsetModel: SimModel = {
  id: "kubernetes-statefulsets",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(values, seed);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, series]) => [key, [...series]]));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.summary = `${values.available} of ${values.replicas} ordinals available; ${values.lost} lost data; ${values.boundClaims} claims bound to ${storageLabel(values.storageMode)}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `${values.available} of ${values.replicas} ordinals are available. ${values.lost > 0 ? `${values.lost} ordinal${values.lost === 1 ? "" : "s"} lost data, not only uptime.` : "No ordinal lost data in this disruption."}`,
      `${values.boundClaims} of ${values.replicas} claims are bound. ${values.storageMode === 0 ? (values.deletePvc === 1 ? "The claim exists in the template, but this scenario deletes it before recreation." : "volumeClaimTemplates gives each ordinal its own claim.") : `${storageLabel(values.storageMode)} is not a per-ordinal persistent claim.`}`,
      values.disruption === 2
        ? "A node failure is not a voluntary disruption. The pod is rescheduled, and the claim must reattach on the new node for the data to follow."
        : values.disruption === 3
          ? "A node pool replacement recreates every ordinal. Stable claims can reattach; ephemeral storage cannot."
          : values.disruption === 1
            ? "A pod restart keeps the ordinal name. Whether it keeps the data depends on the claim, not on the pod name."
            : "No disruption is active. A stable claim still protects the next restart or reschedule.",
      `The headless Service is part of identity: it gives each ordinal a stable DNS name. The claim is the other half. Either one alone is not enough for a stateful workload.`,
    ];
  },
  legend: [
    { label: "Identity and data intact", tone: "ok" },
    { label: "Recreating or at risk", tone: "warn" },
    { label: "Data lost", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Three ordinals, each with a claim from volumeClaimTemplates, and no disruption.",
    tone: "ok",
    params: defaultsFor("healthy"),
  },
  {
    id: "peak",
    label: "Claim deleted",
    description: "A pod restart recreates one ordinal after its PVC was deleted.",
    tone: "warn",
    params: defaultsFor("peak"),
  },
  {
    id: "failure",
    label: "Empty volumes",
    description: "A node pool replacement recreates all three ordinals on emptyDir.",
    tone: "crit",
    params: defaultsFor("failure"),
  },
  {
    id: "reattach",
    label: "Rescheduled",
    description: "A node failure recreates one ordinal, but the stable claim reattaches.",
    tone: "ok",
    params: defaultsFor("reattach"),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Five ordinals use stable claims; every ordinal is available.",
    tone: "ok",
    params: defaultsFor("recovery"),
  },
];

const experiment: Experiment = {
  id: "predict-data-loss",
  title: "Predict whether the data follows the pod",
  simId: "statefulsets",
  question:
    "A StatefulSet uses emptyDir. A node pool replacement recreates all three ordinals. What happens to the data?",
  prediction: {
    options: [
      { id: "survives", label: "It survives because each pod keeps its ordinal name" },
      { id: "claims", label: "It survives because the StatefulSet recreates the PVCs automatically" },
      { id: "lost", label: "It is lost because emptyDir is tied to the pod, not to the ordinal" },
      { id: "quorum", label: "It is lost only for the ordinal that held the leader lease" },
    ],
    correctOptionId: "lost",
    explanation:
      "StatefulSets provide stable identity and, with volumeClaimTemplates, stable claims. emptyDir is deleted with the pod. The ordinal name is preserved, but the data directory is not. The same failure appears when a claim is deleted, or when hostPath keeps data on a node the pod has left.",
  },
  setup: defaults({ replicas: 3, storageMode: 1, deletePvc: 0, disruption: 3 }),
  runFor: 20,
  observe: [
    "All three ordinals are recreated on a new node pool.",
    "The ordinal names are stable; the emptyDir contents are not.",
    "All three ordinals report lost data and zero availability.",
    "Switching to volumeClaimTemplates keeps the claims available for reattachment.",
  ],
  explain:
    "A StatefulSet is a controller contract for identity and ordering, not a backup system. It gives each pod a predictable name and, when volumeClaimTemplates is present, a predictable claim. The volume implementation decides whether the data survives a reschedule. emptyDir and hostPath do not provide a portable claim. Deleting a PVC removes the data even when the pod and the ordinal remain.",
  fix: defaults({ replicas: 3, storageMode: 0, deletePvc: 0, disruption: 3 }),
  debrief:
    "With volumeClaimTemplates, the node pool can be replaced and each ordinal reattaches to its claim. The workload may be unavailable while the pods restart, but the data is not lost. That is the distinction to preserve during an incident: identity tells you which pod should own the data; the claim tells you where the data lives.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A StatefulSet runs pods that need a stable identity. Each pod gets an ordinal name such as pod-0, pod-1, and pod-2, and the controller creates and deletes them in order by default. A headless Service gives each ordinal a stable DNS name. A volumeClaimTemplates entry gives each ordinal its own PersistentVolumeClaim, named from the template and the pod, so a rescheduled pod can reattach to the same claim.",
  },
  {
    type: "p",
    text: "A PersistentVolumeClaim, or PVC, is a request for storage that binds to a PersistentVolume. The claim is the durable object; the pod is not. A StatefulSet does not delete its PVCs when a pod is recreated, when the set is scaled down, or when the StatefulSet itself is deleted. Deleting a claim is a separate action, and it is the action that usually loses data. An emptyDir is deleted with the pod. A hostPath ties data to a node path and does not follow the pod to another node.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The StatefulSet sits above pods and below the storage layer. It controls identity, ordering, and the claim template. The storage class and the volume plugin control binding, attach, and reclaim. The headless Service controls network identity. A production claim spans all three: the StatefulSet chooses an ordinal, the Service names it, and the volume plugin makes the data available on the node where the pod lands.",
  },
  {
    type: "table",
    headers: ["Layer", "What it provides", "What it does not provide"],
    rows: [
      ["StatefulSet", "Ordinal names and ordered rollout", "A durable volume by itself"],
      ["volumeClaimTemplates", "One claim per ordinal", "Backups or cross-region copies"],
      ["Headless Service", "Stable per-pod DNS names", "Load balancing or data replication"],
      ["Storage class", "Binding and reclaim behavior", "Application-level consistency"],
    ],
  },
  {
    type: "compare",
    leftTitle: "Pod recreation",
    rightTitle: "Claim deletion",
    rows: [
      { label: "Trigger", left: "Restart, reschedule, rollout", right: "Manual cleanup or a bad policy" },
      { label: "Ordinal", left: "Preserved", right: "Preserved" },
      { label: "Data", left: "Reattaches if the claim exists", right: "Gone unless restored" },
      { label: "First check", left: "PVC bound and attachable", right: "Why the PVC was deleted" },
    ],
  },
  {
    type: "p",
    text: "This module models one to five ordinals, three storage modes, and four disruption modes. The storage behavior is simplified for teaching. The distinction is real: a StatefulSet gives a pod a name it can keep, and a claim gives it data it can keep. The two guarantees are configured separately.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Each ordinal, its claim name or ephemeral storage mode, and whether it is available.",
      "Lost ordinals and ordinals without a stable claim as separate signals.",
      "The headless Service node beside the StatefulSet, because identity has two halves.",
      "A reschedule preset where availability drops but no data is lost.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note the claim name on each ordinal. Apply Empty volumes: the ordinal names survive but the data does not. Then apply Rescheduled to see the same node failure with a stable claim. Run the experiment before revealing the explanation.",
  },
  { type: "sim", simId: "statefulsets" },
  {
    type: "p",
    text: "When a stateful pod loses data, separate the identity question from the storage question. The ordinal name tells you which member should own the data. The claim tells you where the data was. If the claim was never created, was deleted, or was never durable, the StatefulSet cannot repair that by recreating the pod under the same name.",
  },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The node pool replacement recreated all three ordinals. Because the volumes were emptyDir, each pod started with an empty directory. The ordinal names were preserved, which made the workload look structurally healthy, but three ordinals had lost their data. The StatefulSet did exactly what it promised: stable identity and ordered recreation. It did not promise durable storage, because the volume was not configured for it.",
  },
  {
    type: "p",
    text: "The rescheduled preset used the same node failure with volumeClaimTemplates. One ordinal was unavailable while it moved, but its claim reattached and no data was lost. The difference was not the StatefulSet or the disruption. It was the storage contract under the pod.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "kubectl get statefulset and kubectl get pvc: desired replicas, ordinal pods, and claim binding per ordinal.",
      "Pod events for FailedAttachVolume, FailedMount, and multi-attach errors during rescheduling.",
      "Storage class parameters: access mode, reclaim policy, binding mode, and zone or topology constraints.",
      "Application logs and data checks: a pod can be Running and Ready while its data directory is empty.",
      "Backup and restore evidence, because a claim protects against a restart, not against deletion or corruption.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the PVC for the affected ordinal before deleting or recreating anything. Confirm it is bound and attachable, then check the pod events for attach or mount failures. If the PVC was deleted, stop and restore before the new pod writes over the recovery point.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the affected ordinal and its claim name from the StatefulSet template.",
      "Check whether the claim exists, is bound, and can attach to the new node.",
      "Stop the new pod from serving if it started with an empty volume.",
      "Restore the claim from backup if it was deleted, then restart the ordinal.",
      "Move persistent data into volumeClaimTemplates if the workload used emptyDir or hostPath.",
      "Test a pod deletion and a node reschedule before declaring the fix complete.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Per-ordinal claims isolate data but multiply the number of storage objects to manage.",
      "A regional volume survives a zone failure but adds attach time and cost.",
      "Keeping PVCs after scale-down preserves data but accumulates unused storage and cost.",
      "Ordered pod management protects quorum protocols but slows recovery compared with parallel startup.",
      "A headless Service gives stable names but leaves load balancing and leader discovery to the client.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "new-volume",
    question:
      "A StatefulSet pod is recreated and loses its data, even though the pod name is the same. What do you check?",
    difficulty: 2,
    hints: [
      "The ordinal name and the volume are separate guarantees.",
      "Check the claim, not only the pod.",
    ],
    answer:
      "I check whether the StatefulSet defines volumeClaimTemplates and whether the claim for that ordinal still exists and is bound. If the volume is emptyDir or hostPath, the ordinal name is stable but the data is not portable. If the PVC was deleted before recreation, the new pod binds an empty claim. I would stop the pod from serving, restore the claim from backup, and then test a reschedule. The StatefulSet did not lose the data by itself; the storage contract did not keep it.",
    followUps: [
      "What happens to PVCs when a StatefulSet is deleted?",
      "How would you verify the claim before restarting?",
      "What does a headless Service have to do with this?",
    ],
    redFlags: [
      "Blaming the StatefulSet controller.",
      "Recreating the pod without checking the claim.",
      "Assuming the pod name implies the volume.",
    ],
    rubric: [
      "Separates identity from storage.",
      "Checks PVC existence and binding.",
      "Names emptyDir and hostPath risks.",
      "Restores before serving.",
    ],
  },
  {
    id: "headless-service",
    question:
      "Why does a StatefulSet need a headless Service, and what does DNS return?",
    difficulty: 2,
    hints: [
      "Stable network identity is per ordinal.",
      "A headless Service has no virtual IP.",
    ],
    answer:
      "The headless Service, with clusterIP None, makes DNS return the individual pod endpoints instead of one virtual IP. Each ordinal gets a stable name, which peers use for replication, quorum, or leader discovery. Readiness controls which endpoints appear. The Service does not load balance or elect a leader; it gives the pods names that survive recreation. Without it, the StatefulSet still has ordinal pod names, but the stable network identity that peers rely on is missing.",
    followUps: [
      "What happens to the DNS name when a pod is not ready?",
      "How does a client find the primary?",
      "Would a ClusterIP Service work for a StatefulSet?",
    ],
    redFlags: [
      "Says the headless Service load balances.",
      "Confuses pod name with DNS name.",
      "Ignores readiness.",
    ],
    rubric: [
      "Explains clusterIP None.",
      "Connects ordinal to DNS identity.",
      "Mentions readiness and endpoints.",
      "Does not claim leader election.",
    ],
  },
  {
    id: "pvc-deletion",
    question:
      "A teammate deletes a PVC to fix a stuck pod. What are the consequences, and what should they have done?",
    difficulty: 3,
    hints: [
      "Deleting a claim can delete the backing volume depending on reclaim policy.",
      "A stuck pod is usually an attach or mount problem.",
    ],
    answer:
      "Deleting the PVC can destroy the data if the persistent volume's reclaim policy is Delete, and it always removes the binding the ordinal needs. The pod may then start with a new empty claim. The teammate should have inspected the pod events for attach or mount failures, checked whether the volume was still attached to an old node, and confirmed the PVC's status and reclaim policy. If the claim had to be replaced, they should have restored from backup before starting the pod. Deleting the claim is a data operation, not a pod restart.",
    followUps: [
      "How does the reclaim policy change the outcome?",
      "What would you check for a multi-attach error?",
      "How do you protect against this in RBAC?",
    ],
    redFlags: [
      "Treats a PVC as a cache.",
      "Deletes storage to clear a mount error.",
      "Ignores the reclaim policy.",
    ],
    rubric: [
      "Names the data risk.",
      "Checks events and binding first.",
      "Mentions reclaim policy and backup.",
      "Separates storage from pod lifecycle.",
    ],
  },
  {
    id: "statefulset-vs-deployment",
    question:
      "When would you use a StatefulSet instead of a Deployment, and what does it not solve?",
    difficulty: 3,
    hints: [
      "Identity and storage order are the differentiators.",
      "It is not a replication or backup system.",
    ],
    answer:
      "I use a StatefulSet when members need stable names, per-member storage, and ordered startup or shutdown, such as a database, a quorum system, or a broker with partition ownership. A Deployment treats pods as interchangeable and gives no per-pod claim. The StatefulSet does not replicate data, elect a leader, back up the volume, or guarantee that a rescheduled pod can attach its claim in every zone. Those are application, storage, and operational concerns. I would still test rescheduling, scale-down, and restore before calling it production-ready.",
    followUps: [
      "What does podManagementPolicy Parallel change?",
      "How does a StatefulSet behave during a rolling update?",
      "What would you test before scaling down?",
    ],
    redFlags: [
      "Assumes StatefulSet means highly available.",
      "Expects it to replicate data.",
      "Ignores storage topology.",
    ],
    rubric: [
      "Names identity and per-member storage.",
      "Contrasts with Deployment semantics.",
      "Lists what it does not solve.",
      "Includes operational testing.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every stateful workload uses volumeClaimTemplates with a storage class that matches its durability and topology needs.",
      "The headless Service and per-ordinal DNS names are tested from a peer pod.",
      "PVC deletion is restricted and never used as a pod-restart tactic.",
      "Backups exist independently of the claim and have a tested restore path.",
      "A reschedule and a scale-down test confirm that claims reattach and are not removed.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify the ordinal and its claim before deleting or recreating anything.",
      "Check PVC binding, attach events, and the reclaim policy.",
      "Stop a pod that started with an empty volume before it serves traffic.",
      "Restore the claim from backup if it was deleted.",
      "Record whether the failure was identity, storage, or both.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Keep PVCs retained on scale-down unless a documented policy says otherwise.",
      "Add an alert for unbound claims and repeated attach failures.",
      "Test a node pool replacement with the real storage class.",
      "Review RBAC for PVC deletion and document the recovery procedure.",
    ],
  },
];

const references = [
  {
    title: "StatefulSets",
    url: "https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Ordinal identity, volumeClaimTemplates, and pod management policy.",
  },
  {
    title: "Persistent Volumes",
    url: "https://kubernetes.io/docs/concepts/storage/persistent-volumes/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "PVC binding, access modes, and reclaim policies.",
  },
  {
    title: "Services",
    url: "https://kubernetes.io/docs/concepts/services-networking/service/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Headless Services and stable per-pod DNS names.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    statefulsets: {
      model: statefulsetModel,
      presets,
      instructions:
        "Start Healthy and read the claim name on each ordinal. Apply Empty volumes, then Rescheduled. Compare data loss with availability before you try Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. The storage behavior is simplified to show the identity and claim contract, not a specific volume plugin.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "kubernetes-pods-deployments",
    "kubernetes-dns",
    "kubernetes-node-pressure",
    "databases-primary-replica-lag",
  ],
};
