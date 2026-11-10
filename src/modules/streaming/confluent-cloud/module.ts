import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const INGRESS_LIMIT = 160;
const EGRESS_LIMIT = 240;
const PARTITION_LIMIT = 2_000;

const params = [
  {
    id: "produceMBps",
    label: "Produce throughput",
    min: 20,
    max: 180,
    step: 5,
    value: 90,
    unit: " MB/s",
    group: "Traffic",
    help: "Bytes per second written by all producers into the cluster. Compared with the cluster's ingress limit.",
    format: "number" as const,
  },
  {
    id: "consumeMBps",
    label: "Consume throughput",
    min: 20,
    max: 260,
    step: 10,
    value: 110,
    unit: " MB/s",
    group: "Traffic",
    help: "Bytes per second fetched by all consumer groups. Compared with the cluster's egress limit.",
    format: "number" as const,
  },
  {
    id: "partitions",
    label: "Partitions",
    min: 60,
    max: 2_400,
    step: 60,
    value: 600,
    unit: "",
    group: "Cluster",
    help: "Total partitions across topics in the cluster. Managed clusters have a partition limit that affects metadata and recovery.",
    format: "count" as const,
  },
  {
    id: "privateNetwork",
    label: "Private networking",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Network",
    help: "1 uses a private endpoint path such as AWS PrivateLink. 0 uses the public endpoint and adds internet latency.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  produce: number;
  consume: number;
  partitions: number;
  privateNetwork: boolean;
  ingressUtil: number;
  egressUtil: number;
  partitionUtil: number;
  maxUtil: number;
  throttlePct: number;
  p99: number;
}

function compute(p: Params): Computed {
  const produce = Math.max(1, num(p, "produceMBps", 90));
  const consume = Math.max(1, num(p, "consumeMBps", 110));
  const partitions = Math.max(1, num(p, "partitions", 600));
  const privateNetwork = num(p, "privateNetwork", 1) >= 1;
  const ingressUtil = produce / INGRESS_LIMIT;
  const egressUtil = consume / EGRESS_LIMIT;
  const partitionUtil = partitions / PARTITION_LIMIT;
  const maxUtil = Math.max(ingressUtil, egressUtil);
  const queue = maxUtil > 0.55 ? (maxUtil - 0.55) ** 2 * 2_200 : 0;
  const p99 = 24 + (privateNetwork ? 0 : 55) + partitionUtil * 20 + queue;
  const throttlePct = maxUtil > 1 ? ((maxUtil - 1) / maxUtil) * 100 : 0;
  return {
    produce,
    consume,
    partitions,
    privateNetwork,
    ingressUtil,
    egressUtil,
    partitionUtil,
    maxUtil,
    throttlePct,
    p99,
  };
}

function healthFor(c: Computed): "ok" | "warn" | "crit" {
  if (c.maxUtil >= 1 || c.p99 >= 300 || c.throttlePct >= 5) return "crit";
  if (c.maxUtil >= 0.75 || c.p99 >= 120 || c.throttlePct >= 1) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, flags: SimFrame["flags"]): SimFrame {
  const c = compute(p);
  const health = healthFor(c);
  return {
    t,
    nodes: [
      {
        id: "producers",
        label: "application producers",
        kind: "service",
        health: c.ingressUtil >= 1 ? "crit" : c.ingressUtil >= 0.85 ? "warn" : "ok",
        utilization: clamp(c.ingressUtil),
        sublabel: `${Math.round(c.produce)} MB/s produced`,
        detail: "Client-side producer metrics still exist even when the broker metrics do not. Retry and batch settings are yours to change.",
        meta: { view: "flow" },
      },
      {
        id: "network",
        label: c.privateNetwork ? "private endpoint" : "public endpoint",
        kind: "external",
        health: c.privateNetwork ? "ok" : c.p99 >= 120 ? "warn" : "ok",
        sublabel: c.privateNetwork ? "PrivateLink path" : "internet path",
        detail: c.privateNetwork
          ? "A private endpoint keeps traffic on the cloud backbone and removes public-internet variability."
          : "The public endpoint adds internet latency and is the first thing to compare when only one client population is slow.",
        meta: { view: "flow" },
      },
      {
        id: "cluster",
        label: "managed Kafka cluster",
        kind: "stream",
        health,
        utilization: clamp(c.maxUtil),
        sublabel: `${Math.round(c.throttlePct)}% throttled · ${Math.round(c.p99)} ms p99`,
        detail: `This illustrative cluster is provisioned for ${INGRESS_LIMIT} MB/s ingress, ${EGRESS_LIMIT} MB/s egress, and ${PARTITION_LIMIT.toLocaleString("en-US")} partitions. The broker fleet is managed; these limits are what you can observe and request.`,
        meta: {
          ingressPct: c.ingressUtil * 100,
          egressPct: c.egressUtil * 100,
          partitionPct: c.partitionUtil * 100,
        },
      },
      {
        id: "topic",
        label: "orders topic",
        kind: "stream",
        health: health,
        utilization: clamp(c.partitionUtil),
        sublabel: `${Math.round(c.partitions).toLocaleString("en-US")} partitions`,
        detail: "Partition count drives metadata, client connections, and recovery time. It is a cluster limit and a per-topic design choice.",
        meta: { view: "flow" },
      },
      {
        id: "consumers",
        label: "consumer groups",
        kind: "worker",
        health: c.egressUtil >= 1 ? "crit" : c.egressUtil >= 0.85 ? "warn" : "ok",
        utilization: clamp(c.egressUtil),
        sublabel: `${Math.round(c.consume)} MB/s fetched`,
        detail: "Fetch size, concurrency, and group count are client-side. A single slow consumer group can look like a cluster problem in aggregate.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("producers-network", "producers", "network", clamp(c.produce / 180), health),
      edge("network-cluster", "network", "cluster", clamp(c.produce / 180), health),
      edge("cluster-topic", "cluster", "topic", clamp(c.ingressUtil), health),
      edge("topic-consumers", "topic", "consumers", clamp(c.egressUtil), health),
    ],
    metrics: [
      metric("ingress-util", "Ingress quota used", c.ingressUtil * 100, "%", 75, 90, "percent"),
      metric("egress-util", "Egress quota used", c.egressUtil * 100, "%", 75, 90, "percent"),
      metric("cluster-p99", "Cluster request p99", c.p99, " ms", 120, 300, "ms"),
      metric("throttle-rate", "Throttled request rate", c.throttlePct, "%", 1, 5, "percent"),
      metric("partition-util", "Partition limit used", c.partitionUtil * 100, "%", 80, 95, "percent"),
    ],
    events: [],
    series: {},
    flags: { ...flags, paramsKey: JSON.stringify(p) },
    summary: `${Math.round(c.ingressUtil * 100)}% ingress and ${Math.round(c.egressUtil * 100)}% egress quota used, ${Math.round(c.p99)} ms p99, ${Math.round(c.throttlePct)}% throttled. The broker fleet is managed.`,
  };
}

function seedSeries(frame: SimFrame, c: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 9)) / 2.5);
  const seedValues: [string, number, number][] = [
    ["ingress-util", c.ingressUtil * 100, 1],
    ["egress-util", c.egressUtil * 100, 1],
    ["cluster-p99", c.p99, 3],
    ["throttle-rate", c.throttlePct, 0.1],
    ["partition-util", c.partitionUtil * 100, 0.5],
  ];
  for (const [id, value, amplitude] of seedValues) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "ingress-quota",
    metricId: "ingress-util",
    warn: 75,
    crit: 90,
    title: "Produce traffic is near or above the ingress quota",
    cause:
      "A managed cluster has a provisioned ingress ceiling. As utilization approaches it, client batches queue and the cluster starts throttling. Above the ceiling, produce requests are rejected or delayed.",
    fix:
      "Reduce or reshape produce traffic first, then request a higher cluster limit or move the topic to a larger cluster. You cannot tune the broker, so the levers are client batching, compression, traffic isolation, and capacity.",
    checkFirst: [
      "Compare produced bytes with the cluster's ingress limit, not only with yesterday.",
      "Check whether one topic or producer accounts for the increase.",
      "Check client retry and batch settings for a retry storm.",
    ],
  },
  {
    id: "egress-quota",
    metricId: "egress-util",
    warn: 75,
    crit: 90,
    title: "Consumer fetch traffic is near or above the egress quota",
    cause:
      "Every consumer group fetches its own copy of the data. Adding groups or replaying history multiplies egress even when the stored data does not change.",
    fix:
      "Reduce consumer fan-out, use larger fetches, pause non-critical replays, and request more egress capacity if the demand is real.",
    checkFirst: [
      "Count active consumer groups and their fetch rates.",
      "Check for a new backfill or replay job.",
      "Compare fetch bytes with record bytes to see read amplification.",
    ],
  },
  {
    id: "cluster-latency",
    metricId: "cluster-p99",
    warn: 120,
    crit: 300,
    title: "Cluster request p99 exceeds the client budget",
    cause:
      "Near-quota queueing, a public network path, or a large partition metadata footprint raises tail latency. The managed control plane does not expose broker CPU or disk for you to inspect.",
    fix:
      "Separate network time from cluster time, reduce the load near the quota, and use a private endpoint. If latency remains high at low utilization, open a support case with cluster and client metrics.",
    checkFirst: [
      "Compare the private and public endpoint for the same client.",
      "Check whether p99 tracks ingress utilization or is flat.",
      "Check partition count and recent topic creation.",
    ],
  },
  {
    id: "partition-quota",
    metricId: "partition-util",
    warn: 80,
    crit: 95,
    title: "The cluster is close to its partition limit",
    cause:
      "Partitions consume metadata and file handles and increase controller work. A managed cluster caps them per cluster type, and a large partition count slows recovery and client metadata refresh.",
    fix:
      "Delete unused topics, consolidate low-volume topics, and move high-partition workloads to a cluster sized for them. Do not add partitions to fix a hot key.",
    checkFirst: [
      "List topics by partition count and last production time.",
      "Check whether a test or temporary topic is holding partitions.",
      "Check whether the limit is per cluster or per topic.",
    ],
  },
];

export const confluentCloudModel: SimModel = {
  id: "streaming-confluent-cloud",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, { seed });
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const c = compute(p);
    const next = buildFrame(p, frame.t, frame.flags);
    next.series = frame.series;
    next.events = frame.events;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (c.maxUtil >= 1 && frame.flags.quotaEvent !== 1) {
      pushEvent(next, {
        id: "quota-exceeded",
        at: frame.t,
        severity: "crit",
        title: "Cluster quota is throttling clients",
        detail: `Ingress is at ${Math.round(c.ingressUtil * 100)}% and egress at ${Math.round(c.egressUtil * 100)}% of the illustrative limits. About ${c.throttlePct.toFixed(1)}% of requests are throttled and p99 is ${Math.round(c.p99)} ms.`,
        nodeId: "cluster",
        metricId: "ingress-util",
      });
    }
    next.flags.quotaEvent = c.maxUtil >= 1 ? 1 : 0;

    if (c.maxUtil >= 0.85 && c.maxUtil < 1 && frame.flags.headroomEvent !== 1) {
      pushEvent(next, {
        id: "quota-headroom-low",
        at: frame.t,
        severity: "warn",
        title: "Cluster headroom is below the safety margin",
        detail: `The busiest direction is at ${Math.round(c.maxUtil * 100)}% of its quota. Queueing raises p99 before the hard limit is reached; there is little room for a retry storm.`,
        nodeId: "cluster",
        metricId: "cluster-p99",
      });
    }
    next.flags.headroomEvent = c.maxUtil >= 0.85 && c.maxUtil < 1 ? 1 : 0;

    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    items.push(
      `Ingress is ${Math.round(c.ingressUtil * 100)}% and egress is ${Math.round(c.egressUtil * 100)}% of the illustrative quota; the busiest direction sets the risk.`,
    );
    if (c.maxUtil >= 1) {
      items.push(
        "Requests are already being throttled. Adding consumers or retries makes it worse because retries consume the same quota.",
      );
    } else if (c.maxUtil >= 0.75) {
      items.push(
        "The cluster is in the queueing zone: p99 rises before the hard quota is reached, so a latency alert should fire before the utilization alert.",
      );
    }
    if (!c.privateNetwork && c.p99 >= 80) {
      items.push("The public network path adds a fixed latency penalty. Compare the same client over a private endpoint before blaming the cluster.");
    }
    if (c.partitionUtil >= 0.8) {
      items.push(
        `Partitions use ${Math.round(c.partitionUtil * 100)}% of the cluster limit. That is metadata and recovery cost, not throughput parallelism.`,
      );
    }
    if (frame.metrics.some((item) => item.id === "throttle-rate" && item.value > 0)) {
      items.push("A managed cluster gives you metrics and limits, not broker CPU or disk. Start with quota utilization and the client-side retry rate.");
    }
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
    description: "Comfortable ingress and egress headroom on a private endpoint.",
    tone: "ok",
    params: defaults({ produceMBps: 70, consumeMBps: 90, partitions: 400, privateNetwork: 1 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A large partition footprint and high traffic push p99 into the warning band.",
    tone: "warn",
    params: defaults({ produceMBps: 130, consumeMBps: 190, partitions: 1_600, privateNetwork: 1 }),
  },
  {
    id: "failure",
    label: "Quota hit",
    description: "Peak traffic exceeds ingress and egress limits on the public endpoint.",
    tone: "crit",
    params: defaults({ produceMBps: 180, consumeMBps: 250, partitions: 2_200, privateNetwork: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Traffic is reshaped, partitions are cleaned up, and clients use a private endpoint.",
    tone: "ok",
    params: defaults({ produceMBps: 100, consumeMBps: 130, partitions: 500, privateNetwork: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-quota-latency",
  title: "Predict why p99 jumps before the hard limit",
  simId: "confluent-cloud",
  question:
    "A cluster provisioned for 160 MB/s ingress is producing 150 MB/s. Ingress utilization is 94%, no requests are rejected yet, but p99 has risen from 60 ms to about 360 ms. What is the most likely cause?",
  prediction: {
    options: [
      { id: "broker", label: "A broker disk is failing and needs to be replaced" },
      { id: "queue", label: "Near-quota queueing and throttling are adding tail latency" },
      { id: "partitions", label: "The partition count is too low for the traffic" },
      { id: "dns", label: "DNS resolution is slow on the client" },
    ],
    correctOptionId: "queue",
    explanation:
      "The cluster is close to its ingress ceiling. Requests queue behind the quota, and the client sees that queueing as tail latency before the hard limit produces explicit rejections. You cannot log in to the broker to inspect disk or CPU. The useful signals are quota utilization, throttle rate, p99, and the client-side retry rate. A partition problem would show as a hot partition or consumer lag, not a uniform p99 rise at high ingress.",
  },
  setup: defaults({ produceMBps: 150, consumeMBps: 120, partitions: 800, privateNetwork: 1 }),
  runFor: 20,
  observe: [
    "Ingress utilization sits in the critical band while throttle rate is still small.",
    "p99 rises sharply with utilization because the queue grows non-linearly.",
    "The broker is not visible, so the cluster-level metrics are the evidence you have.",
    "Reducing produce traffic moves p99 back into the warning or healthy band.",
  ],
  explain:
    "Managed Kafka replaces broker operations with cluster-level limits. The provider owns the broker fleet, so the diagnosis moves to the client, the network path, and the quota. A latency incident near a quota is a capacity and admission problem, not a broker-tuning problem. The fix is to shed or reshape load, isolate noisy topics, and request capacity with evidence.",
  fix: defaults({ produceMBps: 120, consumeMBps: 110, partitions: 600, privateNetwork: 1 }),
  debrief:
    "At 120 MB/s, ingress utilization is 75% and p99 returns below the warning line in this illustrative model. The cluster still has limited headroom for a retry storm, so the durable fix is a capacity plan tied to peak traffic and a private network path. The tradeoff is cost: a larger cluster and private connectivity raise the fixed bill.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Confluent Cloud is a managed Apache Kafka service. The provider runs the brokers, storage, and control plane; your team gets a cluster endpoint, a metrics API, and a set of limits. You do not get broker CPU, disk, or JVM access. That changes incident response: the first question is not which broker is slow, but which quota or path is saturated and which client is consuming it.",
  },
  {
    type: "p",
    text: "Managed Kafka still has hard boundaries. Cluster types differ in ingress and egress throughput, partition count, and connection limits. Client traffic crosses a public endpoint or a private endpoint such as AWS PrivateLink. Consumer groups multiply egress because each group fetches its own copy. Partition count is both a per-topic design choice and a cluster-wide metadata cost. When latency rises, those limits and the network path are what you can inspect.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is producer clients, network endpoint, managed cluster, topic partitions, and consumer clients. The provider exposes cluster metrics through its monitoring API and integrations. Your clients expose producer and consumer metrics locally. The gap between the two is the useful diagnostic: a client-side p99 that rises while cluster latency is flat points at the client or the path; both rising together points at the cluster or the quota.",
  },
  {
    type: "table",
    headers: ["Limit or signal", "Where it applies", "What you control"],
    rows: [
      ["Ingress throughput", "Cluster-wide produce path", "Compression, batching, traffic shaping, cluster size"],
      ["Egress throughput", "Cluster-wide fetch path", "Consumer fan-out, fetch size, replay schedule"],
      ["Partition count", "Cluster and topic metadata", "Topic design, cleanup, cluster sizing"],
      ["Connection count", "Client to cluster", "Client pooling, instance count, idle connections"],
      ["Network path", "Client to endpoint", "Public or private endpoint, DNS, routing"],
    ],
  },
  {
    type: "p",
    text: "The simulation uses illustrative limits: 160 MB/s ingress, 240 MB/s egress, and 2,000 partitions. Real cluster limits depend on the cluster type, region, and provider generation. They are teaching values, not a quoted Confluent specification. The lesson is the shape of the response, not the exact number.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Ingress and egress quota utilization, with warning and critical bands before the hard limit.",
      "Cluster request p99, which rises non-linearly as the busiest direction approaches its quota.",
      "Throttled request rate, the signal that the cluster is actively rejecting or delaying work.",
      "Partition limit utilization, which is a metadata and recovery cost rather than consumer parallelism.",
      "A flow view from producers through a public or private endpoint to the managed cluster and consumers.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, apply Peak, then apply Quota hit. Compare the ingress and p99 bands, then switch to the private endpoint in Recovery. Watch how p99 moves before the throttle rate does.",
  },
  { type: "sim", simId: "confluent-cloud" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset produced 180 MB/s into a cluster with an illustrative 160 MB/s ingress limit and fetched 250 MB/s against a 240 MB/s egress limit. Both directions crossed their quotas, 11% of requests were throttled, and p99 reached about 830 ms because queueing grows quickly near the limit. The public endpoint added a fixed latency penalty, but it was not the main cause. The cluster was the bottleneck, and the broker fleet was not something the application team could inspect or tune.",
  },
  {
    type: "p",
    text: "The recovery preset reduced produce to 100 MB/s, consume to 130 MB/s, cleaned the partition footprint down to 500, and moved clients to a private endpoint. Ingress fell to 63% and egress to 54%, p99 returned to about 41 ms, and the throttle rate went to zero. The partition limit also fell from 110% to 25%. The managed cluster was healthy again without any broker change, because the fix was traffic shape, network path, and capacity request.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Confluent Cloud metrics: received and sent bytes, request latency percentiles, throttled requests, and partition count.",
      "Client metrics: producer retry rate, batch size, compression ratio, consumer fetch size, and per-group lag.",
      "Network evidence: private endpoint status, DNS resolution time, and cross-region or cross-AZ traffic.",
      "Cluster audit logs and topic inventory: a new high-partition topic or a replay job often explains a step change.",
      "Support cases and quota history, which show whether the limit was raised or the cluster type changed.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare ingress and egress utilization with the cluster limit, then check the throttle rate. If both are low, compare the private and public path and the client-side p99. Only then look at partition count and consumer fan-out. Do not start by adding consumers.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the busiest direction and the topic or client responsible for the increase.",
      "Shed or reshape load: enable compression, increase batch size, pause non-critical replays, and bound producer retries.",
      "Isolate noisy workloads into a separate cluster or topic so one team cannot consume the shared quota.",
      "Move clients to a private endpoint when the latency gap is on the network path.",
      "Right-size the partition footprint by deleting unused topics and consolidating low-volume ones.",
      "Request a higher cluster limit or a larger cluster with utilization evidence, not with a peak screenshot alone.",
      "Re-test at peak with the retry injector on, and verify p99 and throttle rate together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger cluster or higher quota raises the fixed bill even when traffic is low.",
      "Private networking reduces latency and exposure but adds endpoint cost and cross-account routing work.",
      "Compression lowers network bytes but raises client CPU and can increase latency at high compression levels.",
      "Fewer partitions reduce metadata cost but can cap consumer parallelism and force a topic redesign later.",
      "Isolating workloads into separate clusters protects noisy-neighbor boundaries but multiplies operational overhead.",
      "The provider owns the broker, so the remaining levers are client behavior, topology, and purchased capacity.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "managed-latency-triage",
    question:
      "The application team reports elevated Kafka latency on Confluent Cloud, but they have no broker access. What do you check, in order?",
    difficulty: 2,
    hints: [
      "The provider exposes cluster metrics; clients expose their own.",
      "Separate the network path from the cluster path.",
    ],
    answer:
      "I would start with the cluster's ingress and egress utilization, request p99, throttle rate, and partition count from the metrics API, then compare them with the client-side producer and consumer latency. If client p99 is high while cluster p99 is flat, I would look at the network path, DNS, and the client's retry or batch settings. If both are high, I would check quota pressure and the topics driving it. I would also compare a private endpoint with the public endpoint and check whether a new consumer group or replay job started. The provider owns the broker, so the evidence has to come from these boundary metrics.",
    followUps: [
      "What would make you open a support case?",
      "How do you tell a cluster quota problem from a hot partition?",
      "Which client metric would you check first?",
    ],
    redFlags: [
      "Asks for broker SSH access.",
      "Adds consumers without checking quota.",
      "Treats all latency as a cluster problem.",
    ],
    rubric: [
      "Starts with cluster and client metrics.",
      "Separates network from cluster.",
      "Names quota and partition signals.",
      "Has an escalation path.",
    ],
  },
  {
    id: "quota-peak-response",
    question:
      "During a peak, ingress utilization reaches 100% and producers start throttling. What do you do in the first ten minutes, and what do you change afterward?",
    difficulty: 2,
    hints: [
      "Retries consume the same quota as original traffic.",
      "The durable fix is capacity or workload isolation.",
    ],
    answer:
      "In the first ten minutes I would reduce demand, not add it: pause non-critical producers and replays, bound retries with a backoff and a maximum, and check whether one topic or tenant is responsible. I would confirm whether the limit is ingress or egress and whether a recent deploy changed batch size or compression. After the incident I would right-size the cluster or request a quota increase, isolate the noisy workload, and add an alert on utilization at a level that leaves room for retries. I would not expect a broker setting to fix it, because the broker is managed.",
    followUps: [
      "Why can retries make a quota incident worse?",
      "What utilization level would you alert on?",
      "When would you move a topic to another cluster?",
    ],
    redFlags: [
      "Increases producer retries.",
      "Assumes the limit can be changed instantly.",
      "Has no workload isolation plan.",
    ],
    rubric: [
      "Sheds load before adding capacity.",
      "Names retry amplification.",
      "Plans capacity and isolation.",
      "Chooses a leading alert threshold.",
    ],
  },
  {
    id: "network-path",
    question:
      "Only one client population sees high latency, while the cluster metrics look normal. How do you use the network path in the diagnosis?",
    difficulty: 2,
    hints: [
      "Compare the same workload over private and public endpoints.",
      "Look at DNS, cross-region traffic, and endpoint placement.",
    ],
    answer:
      "I would compare the affected clients with an unaffected client in the same region and with the same topic. If cluster p99 is flat, the difference is likely path or client side. I would check whether the affected clients use the public endpoint or a private endpoint in another region, measure DNS and connection setup time, and look for cross-AZ or cross-region traffic. Then I would move a canary to a private endpoint in the same region and compare p99. If latency follows the client, the cluster is not the cause.",
    followUps: [
      "What does a private endpoint change about DNS?",
      "How would you prove the cluster is not the cause?",
      "What is the cost of private connectivity?",
    ],
    redFlags: [
      "Blames the cluster without a comparison.",
      "Ignores cross-region placement.",
      "Changes producer settings before measuring the path.",
    ],
    rubric: [
      "Uses a controlled comparison.",
      "Checks DNS and region placement.",
      "Separates client and cluster latency.",
      "States the cost tradeoff.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Cluster ingress, egress, partition, and connection limits are documented with the alert thresholds.",
      "Dashboards pair cluster metrics with client producer and consumer metrics.",
      "Private endpoint status and region placement are inventoried per client population.",
      "A peak-load test includes the retry behavior that a quota breach would trigger.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify the saturated direction and the topic or client responsible.",
      "Pause replays and non-critical producers before changing client retries.",
      "Compare private and public paths if cluster latency is flat.",
      "Record utilization, throttle rate, and p99 for the support case.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Right-size the cluster or request a quota increase with evidence.",
      "Isolate noisy workloads and remove unused partitions.",
      "Update the runbook to reflect that brokers are not customer-managed.",
      "Re-run peak traffic and verify headroom for retries.",
    ],
  },
];

const references = [
  {
    title: "Confluent Cloud cluster types and limits",
    url: "https://docs.confluent.io/cloud/current/clusters/cluster-types.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "Cluster tiers, throughput, partition, and connection characteristics.",
  },
  {
    title: "Confluent Cloud quotas",
    url: "https://docs.confluent.io/cloud/current/quotas/quotas.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "Service quotas and how limits apply to managed clusters.",
  },
  {
    title: "Confluent Cloud metrics API",
    url: "https://docs.confluent.io/cloud/current/monitoring/metrics-api.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "Cluster and client metrics available without broker access.",
  },
  {
    title: "Confluent Cloud networking overview",
    url: "https://docs.confluent.io/cloud/current/networking/overview.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "Public and private connectivity options, including PrivateLink.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "confluent-cloud": {
      model: confluentCloudModel,
      presets,
      instructions:
        "Start Healthy, apply Peak, then Quota hit. Compare ingress utilization with p99 and throttle rate, then apply Recovery with the private endpoint.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Cluster limits are teaching values, not a quoted Confluent Cloud specification.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-partition-count",
    "streaming-consumer-lag",
    "streaming-hot-partition",
    "streaming-kafka-isr",
  ],
};
