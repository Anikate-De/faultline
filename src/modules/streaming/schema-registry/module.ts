import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const INPUT_RATE = 5_000;
const ROLLOUT_AT = 5;

const params = [
  {
    id: "compatibility",
    label: "Compatibility",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Registry",
    help: "0 backward, 1 forward, 2 full, 3 none. The mode decides which schema changes the registry accepts.",
    format: "count" as const,
  },
  {
    id: "change",
    label: "Schema change",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Change",
    help: "0 optional field with a default, 1 required field without a default, 2 remove a field without a default, 3 rename a field without an alias. The deploy order determines who sees the change first.",
    format: "count" as const,
  },
  {
    id: "oldConsumerShare",
    label: "Old consumers",
    min: 0,
    max: 100,
    step: 5,
    value: 20,
    unit: "%",
    group: "Rollout",
    help: "Share of the consumer fleet still running the previous schema when the producer changes.",
    format: "percent" as const,
  },
  {
    id: "deployOrder",
    label: "Deploy order",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Rollout",
    help: "0 upgrades consumers first; 1 upgrades producers first. The safe order depends on the compatibility direction.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function registryAccepts(compatibility: number, change: number): boolean {
  if (compatibility === 3) return true;
  if (change === 0) return true;
  if (change === 1) return compatibility === 1;
  if (change === 2) return compatibility === 0;
  return false;
}

function affectedShare(change: number, order: number, oldShare: number): number {
  const old = clamp(oldShare / 100, 0, 1);
  if (change === 0) return 0;
  if (change === 1) return order === 1 ? old : 1 - old;
  if (change === 2) return order === 1 ? old : 0;
  return order === 1 ? old : 1 - old;
}

const compatibilityNames = ["backward", "forward", "full", "none"];
const changeNames = ["optional field", "required field", "remove field without default", "rename field without alias"];
const orderNames = ["consumers first", "producers first"];

interface Snapshot {
  accepted: boolean;
  blocked: boolean;
  errorRate: number;
  errorPct: number;
  affected: number;
  oldRate: number;
  newRate: number;
}

function snapshotFor(p: Params, t: number): Snapshot {
  const compatibility = Math.round(num(p, "compatibility", 0));
  const change = Math.round(num(p, "change", 0));
  const order = Math.round(num(p, "deployOrder", 0));
  const oldShare = clamp(num(p, "oldConsumerShare", 20), 0, 100);
  const accepted = registryAccepts(compatibility, change);
  const affected = accepted ? affectedShare(change, order, oldShare) : 0;
  const live = t >= ROLLOUT_AT;
  const errorRate = live ? INPUT_RATE * affected : 0;
  return {
    accepted,
    blocked: !accepted,
    errorRate,
    errorPct: live ? affected * 100 : 0,
    affected,
    oldRate: INPUT_RATE * (oldShare / 100),
    newRate: INPUT_RATE * (1 - oldShare / 100),
  };
}

function buildFrame(p: Params, t: number, snapshot: Snapshot, flags: SimFrame["flags"]): SimFrame {
  const compatibility = Math.round(num(p, "compatibility", 0));
  const change = Math.round(num(p, "change", 0));
  const order = Math.round(num(p, "deployOrder", 0));
  const oldShare = clamp(num(p, "oldConsumerShare", 20), 0, 100);
  const oldAffected = snapshot.errorRate > 0 && affectedShare(change, order, oldShare) > 0 && order === 1;
  const newAffected = snapshot.errorRate > 0 && affectedShare(change, order, oldShare) > 0 && order === 0;
  const consumersHealth = healthFor(snapshot.errorRate, 10, 100);
  return {
    t,
    nodes: [
      {
        id: "producer",
        label: "orders producer",
        kind: "service",
        health: snapshot.blocked ? "warn" : "ok",
        utilization: clamp(INPUT_RATE / INPUT_RATE),
        throughput: INPUT_RATE,
        sublabel: snapshot.blocked ? "new schema rejected" : "writing with the new schema",
        detail: snapshot.blocked
          ? `The registry rejected the ${changeNames[change] ?? "change"} under ${compatibilityNames[compatibility] ?? "unknown"} compatibility. The producer stays on the previous schema, so no consumer sees the change.`
          : `The producer is writing the ${changeNames[change] ?? "change"} with ${compatibilityNames[compatibility] ?? "unknown"} compatibility. ${orderNames[order] ?? "Rollout order unknown"}.`,
        meta: { view: "flow", compatibility, accepted: snapshot.accepted ? 1 : 0 },
      },
      {
        id: "registry",
        label: "schema registry",
        kind: "service",
        health: snapshot.blocked ? "warn" : "ok",
        utilization: snapshot.blocked ? 1 : 0,
        throughput: 0,
        sublabel: snapshot.blocked ? "change rejected" : "change accepted",
        detail: snapshot.blocked
          ? `A ${compatibilityNames[compatibility]} schema can't accept this change. The registry is protecting consumers by refusing the new version. The release is blocked, not broken.`
          : `The registry accepted the new version. Compatibility checks schema shape, not the data already in the topic or the order in which applications deploy.`,
        meta: { compatibility, accepted: snapshot.accepted ? 1 : 0 },
      },
      {
        id: "topic",
        label: "orders.events",
        kind: "stream",
        health: consumersHealth,
        throughput: INPUT_RATE,
        sublabel: `${INPUT_RATE.toLocaleString("en-US")} rec/s · mixed schema versions`,
        detail: "The topic holds records written under the old and new schema during the rollout. Consumers must tolerate both shapes for the duration of the deploy.",
        meta: { errorRate: snapshot.errorRate },
      },
      {
        id: "old-consumers",
        label: "old consumers",
        kind: "worker",
        health: oldAffected ? consumersHealth : "ok",
        utilization: oldAffected ? 1 : 0,
        throughput: snapshot.oldRate,
        capacity: snapshot.oldRate,
        sublabel: `${oldShare.toFixed(0)}% fleet${oldAffected ? " · schema errors" : ""}`,
        detail: oldAffected
          ? `These consumers still expect the previous schema. Records written with the new shape fail deserialization or validation at about ${Math.round(snapshot.errorRate).toLocaleString("en-US")} per second.`
          : "These consumers can read the records they receive during the rollout. They may ignore fields they do not know.",
        meta: { share: oldShare, errorRate: oldAffected ? snapshot.errorRate : 0 },
      },
      {
        id: "new-consumers",
        label: "new consumers",
        kind: "worker",
        health: newAffected ? consumersHealth : "ok",
        utilization: newAffected ? 1 : 0,
        throughput: snapshot.newRate,
        capacity: snapshot.newRate,
        sublabel: `${(100 - oldShare).toFixed(0)}% fleet${newAffected ? " · schema errors" : ""}`,
        detail: newAffected
          ? `These consumers expect the new schema while old records are still in the topic. Missing fields or renamed fields fail at about ${Math.round(snapshot.errorRate).toLocaleString("en-US")} per second.`
          : "These consumers can read both the old and new records in the topic.",
        meta: { share: 100 - oldShare, errorRate: newAffected ? snapshot.errorRate : 0 },
      },
    ],
    edges: [
      edge("producer-registry", "producer", "registry", 1, snapshot.blocked ? "warn" : "ok"),
      edge("registry-topic", "registry", "topic", snapshot.accepted ? 1 : 0, snapshot.blocked ? "warn" : "ok"),
      edge("topic-old", "topic", "old-consumers", clamp(snapshot.oldRate / INPUT_RATE), oldAffected ? consumersHealth : "ok"),
      edge("topic-new", "topic", "new-consumers", clamp(snapshot.newRate / INPUT_RATE), newAffected ? consumersHealth : "ok"),
    ],
    metrics: [
      metric("schema-errors", "Schema errors", snapshot.errorRate, " err/s", 10, 100, "rps"),
      metric("consumer-error-rate", "Consumer error rate", snapshot.errorPct, "%", 1, 5, "percent"),
      metric("release-blocked", "Release blocked", snapshot.blocked ? 1 : 0, "", 0.5, 2, "count"),
      metric("affected-consumers", "Affected consumers", snapshot.affected * 100, "%", 10, 25, "percent"),
      metric("input-rate", "Input rate", INPUT_RATE, " rec/s", undefined, undefined, "rps"),
      metric("compatible-version", "Accepted version", snapshot.accepted ? 1 : 0, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      ...flags,
      seed: Number(flags.seed ?? 0),
      accepted: snapshot.accepted ? 1 : 0,
      blocked: snapshot.blocked ? 1 : 0,
      errorRate: snapshot.errorRate,
      affected: snapshot.affected,
    },
    summary: snapshot.blocked
      ? `The ${compatibilityNames[compatibility] ?? "unknown"} registry rejected the ${changeNames[change] ?? "change"}; the deploy is blocked before consumers are exposed.`
      : `The ${changeNames[change] ?? "change"} is live with ${(snapshot.errorPct).toFixed(0)}% of records failing on consumers; ${orderNames[order] ?? "rollout order unknown"}.`,
  };
}

function seedSeries(frame: SimFrame, snapshot: Snapshot, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 23)) / 2.5);
  const values: [string, number][] = [
    ["schema-errors", snapshot.errorRate],
    ["consumer-error-rate", snapshot.errorPct],
    ["release-blocked", snapshot.blocked ? 1 : 0],
    ["affected-consumers", snapshot.affected * 100],
    ["input-rate", INPUT_RATE],
    ["compatible-version", snapshot.accepted ? 1 : 0],
  ];
  for (const [id, value] of values) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const schemaRegistryModel: SimModel = {
  id: "streaming-schema-registry",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const snapshot = snapshotFor(p, 0);
    const frame = buildFrame(p, 0, snapshot, { seed });
    seedSeries(frame, snapshot, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const seconds = Math.min(1, Math.max(0.01, dt));
    const t = frame.t + seconds;
    const snapshot = snapshotFor(p, t);
    const next = buildFrame(p, t, snapshot, frame.flags);
    next.series = frame.series;
    next.events = frame.events;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (snapshot.blocked && frame.flags.rejectedSeen !== 1) {
      pushEvent(next, {
        id: "schema-change-rejected",
        at: t,
        severity: "warn",
        title: "The registry rejected the schema change",
        detail: `The ${changeNames[Math.round(num(p, "change", 0))] ?? "change"} is not compatible with the current version under ${compatibilityNames[Math.round(num(p, "compatibility", 0))] ?? "this mode"}. No producer can publish it, so consumers are not exposed. The release is blocked.`,
        nodeId: "registry",
        metricId: "release-blocked",
      });
      next.flags.rejectedSeen = 1;
    }
    if (snapshot.errorRate > 0 && frame.flags.schemaErrorSeen !== 1) {
      pushEvent(next, {
        id: "schema-consumer-errors",
        at: t,
        severity: "crit",
        title: "Consumers are failing on the new record shape",
        detail: `About ${Math.round(snapshot.errorRate).toLocaleString("en-US")} records per second fail deserialization or validation. ${snapshot.errorPct.toFixed(0)}% of the consumer fleet is affected.`,
        nodeId: "topic",
        metricId: "schema-errors",
      });
      next.flags.schemaErrorSeen = 1;
    }
    if (!snapshot.blocked && snapshot.errorRate === 0 && t >= ROLLOUT_AT && frame.flags.safeRollout !== 1) {
      pushEvent(next, {
        id: "schema-safe-rollout",
        at: t,
        severity: "info",
        title: "The schema change is compatible with both fleets",
        detail: `The registry accepted the change and no consumer shape fails on the mixed records. ${orderNames[Math.round(num(p, "deployOrder", 0))] ?? "The rollout order"} is safe for this change.`,
        nodeId: "registry",
        metricId: "schema-errors",
      });
      next.flags.safeRollout = 1;
    }
    if (snapshot.errorRate > 0) next.flags.safeRollout = 0;
    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds: [
    {
      id: "schema-errors",
      metricId: "schema-errors",
      warn: 10,
      crit: 100,
      title: "Consumers are failing on the new schema",
      cause:
        "Records written with the new shape are being read by a consumer that expects the old shape. A required field, a removed field without a default, or a rename changes the contract, and the registry's compatibility mode only checks whether the schema can be registered, not whether the deploy order matches.",
      fix:
        "Roll back the producer to the previous schema, then deploy the change in the direction the compatibility mode supports. Prefer an optional field with a default so both shapes can coexist. Verify the registry's accepted version before changing the producer.",
      checkFirst: [
        "Check the registry's accepted version and the consumer's schema ID.",
        "Check whether the failure started at the producer deploy or the consumer deploy.",
        "Check whether old records remain in the topic with the previous shape.",
      ],
    },
    {
      id: "consumer-error-rate",
      metricId: "consumer-error-rate",
      warn: 1,
      crit: 5,
      title: "A meaningful share of consumers cannot read the topic",
      cause:
        "The new schema is not readable by part of the fleet. The affected share is the number of consumers still on the incompatible version, so a small canary can hide a large blast radius until the rollout reaches the fleet.",
      fix:
        "Stop the rollout, identify which consumer version is failing, and route it to the previous schema or a compatible reader. A dual-read window or a defaulted optional field lets both versions coexist while the fleet catches up.",
      checkFirst: [
        "Split errors by consumer version and schema ID.",
        "Check the share of the fleet on each version.",
        "Check whether the topic still contains records written before the change.",
      ],
    },
    {
      id: "release-blocked",
      metricId: "release-blocked",
      warn: 0.5,
      crit: 2,
      title: "The registry is blocking the release",
      cause:
        "The requested change is incompatible with the registered schema under the current mode. The registry is doing its job: publishing the change would break a reader, so it refuses the new version.",
      fix:
        "Change the schema evolution rather than lowering compatibility. Add an optional field with a default, use a new field name instead of a rename, or stage the change over two releases. If the mode is wrong for the service contract, change it deliberately with the consumers' agreement.",
      checkFirst: [
        "Read the registry's compatibility error and identify the incompatible field.",
        "Check which compatibility mode the subject uses and who set it.",
        "Check whether the change can be expressed as an optional field with a default.",
      ],
    },
  ],
  insights: (frame, p) => {
    const snapshot = snapshotFor(p, frame.t);
    const compatibility = Math.round(num(p, "compatibility", 0));
    const change = Math.round(num(p, "change", 0));
    const order = Math.round(num(p, "deployOrder", 0));
    const items: string[] = [];
    items.push(
      `${compatibilityNames[compatibility] ?? "unknown"} compatibility ${snapshot.accepted ? "accepted" : "rejected"} the ${changeNames[change] ?? "change"}.`,
    );
    if (snapshot.blocked) {
      items.push("The release is blocked before any consumer sees the change. That is a safe failure, but it is still a delivery failure.");
    } else if (snapshot.errorRate > 0) {
      items.push(`${snapshot.errorPct.toFixed(0)}% of the fleet is failing at about ${Math.round(snapshot.errorRate).toLocaleString("en-US")} records per second. The deploy order exposed the incompatible side.`);
    } else {
      items.push("No consumer is failing. The change is compatible with both shapes during the rollout.");
    }
    items.push(`The rollout is ${orderNames[order] ?? "unknown"}. Backward-compatible changes usually deploy consumers first; forward-compatible changes deploy producers first.`);
    items.push("A registry check validates schema shape. It does not prove that old records, old consumers, or an external sink will accept the new shape.");
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
    description: "An optional field is added under backward compatibility, with consumers upgraded first.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A rename reaches a small share of old consumers and produces a warning, not a broad outage.",
    tone: "warn",
    params: defaults({ compatibility: 3, change: 3, oldConsumerShare: 1, deployOrder: 1 }),
  },
  {
    id: "failure",
    label: "Required field",
    description: "A required field is published under no compatibility checks while most consumers are still old.",
    tone: "crit",
    params: defaults({ compatibility: 3, change: 1, oldConsumerShare: 80, deployOrder: 1 }),
  },
  {
    id: "rejected",
    label: "Registry rejects",
    description: "Backward compatibility refuses the required field. The deploy is blocked but consumers are safe.",
    tone: "warn",
    params: defaults({ compatibility: 0, change: 1, oldConsumerShare: 80, deployOrder: 1 }),
  },
  {
    id: "recovery",
    label: "Add optional with default",
    description: "Full compatibility accepts only an optional field, and consumers deploy first.",
    tone: "ok",
    params: defaults({ compatibility: 2, change: 0, oldConsumerShare: 80, deployOrder: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-schema-safe-change",
  title: "Predict the safe schema change",
  simId: "schema-registry",
  question:
    "A producer adds a required field and old consumers start failing during the rollout. You need to add the field without a consumer outage. What is the safest change?",
  prediction: {
    options: [
      { id: "optional", label: "Add it as an optional field with a default, deploy consumers first, then producers" },
      { id: "forward", label: "Switch to forward compatibility and deploy producers first" },
      { id: "none", label: "Turn compatibility checks off and deploy faster" },
      { id: "consumers", label: "Add more consumers so the failing ones have help" },
    ],
    correctOptionId: "optional",
    explanation:
      "A required field with no default breaks backward compatibility: a new consumer reading an old record has no value for it. An optional field with a default is readable in both directions, so old consumers ignore it and new consumers can fill it in. Deploying consumers first means the readers tolerate both shapes before the producer emits the new one. Forward compatibility can accept a required field for old readers, but new consumers still need a default when they read old records, so it is not the whole fix.",
  },
  setup: defaults({ compatibility: 3, change: 1, oldConsumerShare: 80, deployOrder: 1 }),
  runFor: 30,
  observe: [
    "Schema errors start at the producer rollout and rise with the share of old consumers.",
    "The registry accepted the change because compatibility was set to none.",
    "Old consumers fail on records that lack the field they expect.",
    "With an optional field and a default, both old and new consumers can read the mixed records.",
  ],
  explain:
    "Compatibility modes are a contract about schema evolution, not a deployment strategy. Backward compatibility lets new readers read old data, which usually means consumers deploy first. Forward compatibility lets old readers read new data, which usually means producers deploy first. Full compatibility requires both. Adding a required field is the classic mistake because it breaks one direction no matter which order you choose. An optional field with a default, followed by a backfill, is the change that can survive a mixed fleet.",
  fix: defaults({ compatibility: 2, change: 0, oldConsumerShare: 80, deployOrder: 0 }),
  debrief:
    "The optional field is accepted under full compatibility and both consumer versions can read the topic while the fleet upgrades. The 80% of old consumers keep working because they ignore the new field, and new consumers use the default when they read old records. The tradeoff is a two-step evolution: add the field with a default, backfill the data, then tighten the contract in a later release if it must become required.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A schema registry stores the event schemas for a topic and checks each new version before producers can use it. The check is called compatibility. A compatible change lets producers and consumers upgrade at different times without a flag day; an incompatible change is rejected or breaks readers. The registry does not deploy applications, so the mode and the deploy order have to be chosen together.",
  },
  {
    type: "p",
    text: "Backward compatibility means a consumer using the new schema can read data written with the old schema. Forward compatibility means a consumer using the old schema can read data written with the new schema. Full compatibility requires both. None accepts everything. The names describe the direction of readability, not the quality of the mode. A backward-compatible change usually deploys consumers first; a forward-compatible change usually deploys producers first.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is producer, serializer, schema registry, topic, deserializer, consumer. The producer asks the registry for the schema ID and serializes the record with it. The consumer fetches the schema by ID and deserializes. During a rollout, the topic holds records with more than one schema ID, so both old and new consumers may read both shapes. The registry checks the schema's shape, not the records already in the topic, the consumer's code, or an external sink's expectations.",
  },
  {
    type: "table",
    headers: ["Mode", "Can read", "Typical deploy order"],
    rows: [
      ["Backward", "New consumers read old and new data", "Consumers first, then producers"],
      ["Forward", "Old consumers read old and new data", "Producers first, then consumers"],
      ["Full", "Both directions are checked", "Either order, but only compatible changes"],
      ["None", "Nothing is checked", "Any order; the registry will not protect you"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative values: 5,000 records per second, four schema changes, and a consumer fleet from 0% to 100% old. They are teaching values, not Confluent limits. The shape of the failure is the lesson: a schema change that is accepted can still break a reader whose version and deploy order do not match it.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Schema errors per second. Warning at 10, critical at 100.",
      "Consumer error rate as a share of the fleet. Warning at 1%, critical at 5%.",
      "Release blocked: the registry rejected the change, so no consumer is exposed.",
      "Affected consumers: the share whose version is incompatible with the new shape.",
      "A flow view with the producer, registry, topic, old consumers, and new consumers.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Required field. Watch errors begin at the producer rollout and scale with the old-consumer share. Run the experiment before changing sliders, then compare Registry rejects and Add optional with default.",
  },
  { type: "sim", simId: "schema-registry" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The producer published a required field with compatibility set to none. The registry accepted the schema because no check was enabled. The producer deployed first, so old consumers received records that lacked a field they expected. Errors began at the producer rollout and rose with the 80% share of old consumers. The new consumers were fine, which made a canary or a small sample look healthy while most of the fleet failed.",
  },
  {
    type: "p",
    text: "Recovery used full compatibility and an optional field with a default, with consumers deployed first. The registry accepted the change because it was readable in both directions. Old consumers ignored the new field, and new consumers filled the default when they read old records. No consumer failed during the mixed-schema window.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Deserialization errors split by consumer version and schema ID.",
      "The registry's subject version, compatibility mode, and rejected-schema error.",
      "Producer schema ID changing before the consumer fleet has upgraded.",
      "A topic with a mix of old and new records during the rollout.",
      "Consumer lag or restarts that begin at the producer deploy, not at a broker event.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the registry's accepted version and the compatibility mode. Then check which side deployed first and which consumer versions are failing. If the registry rejected the change, no consumer is exposed; fix the schema evolution rather than lowering compatibility.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the producer rollout if consumers are failing. The previous schema is still the safe contract.",
      "Read the registry error and identify the incompatible field or direction.",
      "Change the evolution: add an optional field with a default, use a new name instead of a rename, or stage the change over releases.",
      "Deploy consumers first for a backward-compatible change, or producers first for a forward-compatible one.",
      "Verify that both old and new records deserialize in a mixed-version test topic.",
      "Backfill the new field, then tighten the contract in a later release if it must become required.",
      "Re-run the rollout with a canary that includes old consumers, not only the new version.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Optional fields with defaults are flexible but require a backfill and a later cleanup if the field becomes required.",
      "Full compatibility is the safest check but rejects changes that one direction alone would allow.",
      "Forward compatibility lets producers move first but leaves new consumers dependent on defaults when they read old records.",
      "Turning compatibility off speeds delivery and removes the registry's protection; it is a deliberate risk, not a default.",
      "Keeping old schema versions forever supports replay but expands the test matrix and the registry's retained state.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "compatibility-directions",
    question:
      "Explain backward, forward, and full compatibility, and which deploy order each implies.",
    difficulty: 3,
    hints: [
      "Start from who reads whose data.",
      "The name describes the reader that is protected, not the producer.",
    ],
    answer:
      "Backward compatibility means a new consumer can read data written with the old schema, so consumers can upgrade first and still read the old records. Forward compatibility means an old consumer can read data written with the new schema, so producers can upgrade first while old consumers continue. Full compatibility requires both directions, which restricts the change set but lets either side move first. None means the registry will not protect a reader. The deploy order follows the direction: consumers first for backward, producers first for forward, and a compatible change for full.",
    followUps: [
      "Which change breaks backward compatibility?",
      "Which change breaks forward compatibility?",
      "Why does a required field break one direction?",
    ],
    redFlags: [
      "Treats backward and forward as synonyms.",
      "Chooses a mode without a deploy order.",
      "Assumes full compatibility accepts every change.",
    ],
    rubric: [
      "Defines each direction by the reader.",
      "Maps each mode to a deploy order.",
      "Names a change that breaks each direction.",
    ],
  },
  {
    id: "required-field",
    question:
      "A producer wants to add a required field. How do you ship it without breaking old consumers?",
    difficulty: 3,
    hints: [
      "A required field with no default cannot be read from old records.",
      "A two-step evolution is usually cheaper than a flag day.",
    ],
    answer:
      "I would not publish a required field directly. I would add the field as optional with a default, deploy consumers that tolerate the missing value, then deploy the producer that writes it. After a backfill, if the field must become required, I would tighten it in a later release with a compatibility check and a mixed-version test. If the field truly must be required immediately, the safe direction is forward compatibility with producers first for old readers, but new consumers reading old records still need a default, so the optional-with-default path is more robust.",
    followUps: [
      "What does the default value mean for old records?",
      "When can you make the field required?",
      "How would you test the mixed-version window?",
    ],
    redFlags: [
      "Adds the required field directly.",
      "Sets compatibility to none.",
      "Deploys consumers and producers at the same time with no overlap.",
    ],
    rubric: [
      "Starts with an optional field and a default.",
      "Names a consumer-first or compatible rollout.",
      "Includes a backfill and a later tightening step.",
      "Tests the mixed-version window.",
    ],
  },
  {
    id: "registry-rejection",
    question:
      "The registry rejects a schema change the team says is safe. What do you do?",
    difficulty: 3,
    hints: [
      "The registry checks the schema contract, not the application's intent.",
      "Lowering compatibility moves the risk to consumers.",
    ],
    answer:
      "I would read the compatibility error and identify the exact field and direction that failed. Then I would check whether the change can be expressed in a compatible way: an optional field with a default, a new field instead of a rename, or a two-release expansion and contraction. I would not lower the compatibility mode just to unblock the release unless the consumers explicitly accept the new contract and the deploy order is coordinated. The registry's rejection is a safe failure; the dangerous alternative is publishing a shape that some consumer cannot read.",
    followUps: [
      "When is lowering compatibility legitimate?",
      "How would you coordinate a mode change across teams?",
      "What test would prove the new shape is safe?",
    ],
    redFlags: [
      "Disables compatibility to unblock the deploy.",
      "Does not read the registry error.",
      "Assumes all consumers run the latest version.",
    ],
    rubric: [
      "Identifies the incompatible field and direction.",
      "Offers a compatible evolution.",
      "Treats the rejection as a safe failure.",
      "Requires consumer agreement for a mode change.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each subject has a documented compatibility mode and an owner.",
      "Producers and consumers are tested against mixed old and new records.",
      "Consumer versions and schema IDs are visible in dashboards and traces.",
      "The rollout plan states which side deploys first and why.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Stop the producer rollout if consumers are failing.",
      "Read the registry error and identify the incompatible field and direction.",
      "Split errors by consumer version and schema ID.",
      "Do not lower compatibility without consumer agreement and a deploy-order plan.",
      "Record the accepted version, rejected version, and rollout timestamps.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Change the evolution to an optional field with a default or a staged expansion.",
      "Replay or repair records that failed deserialization.",
      "Verify both old and new consumers on a mixed-version topic.",
      "Backfill the new field before tightening the contract.",
    ],
  },
];

const references = [
  {
    title: "Confluent documentation: schema evolution and compatibility",
    url: "https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "Backward, forward, full, and transitive compatibility modes with allowed changes.",
  },
  {
    title: "Confluent documentation: formats, serializers, and deserializers",
    url: "https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/index.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "How schema IDs are written and resolved by producers and consumers.",
  },
  {
    title: "Apache Kafka documentation: producer configs",
    url: "https://kafka.apache.org/documentation/#producerconfigs",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Producer serializer and client configuration context.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "schema-registry": {
      model: schemaRegistryModel,
      presets,
      instructions:
        "Start Healthy, then apply Required field. Watch errors begin at the producer rollout and scale with the old-consumer share. Run the experiment, then compare Registry rejects and Add optional with default.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Rates and fleet shares are teaching values, not Confluent limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-keys-ordering",
    "streaming-cdc",
    "streaming-transactions",
    "streaming-consumer-groups",
    "streaming-poison-messages",
  ],
};
