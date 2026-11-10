import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const YEAR_SECONDS = 60;
const READ_RATE = 2_000;
const ARCHIVE_RATIO = 0.4;

const params = [
  {
    id: "ingestGbPerDay",
    label: "New data per day",
    min: 10,
    max: 500,
    step: 10,
    value: 100,
    unit: " GB/day",
    group: "Bucket",
    help: "Data written each day. The model ages it through the lifecycle rules for one simulated year.",
    format: "number" as const,
  },
  {
    id: "transitionDays",
    label: "Transition after",
    min: 1,
    max: 365,
    step: 1,
    value: 180,
    unit: " days",
    group: "Lifecycle",
    help: "Object age when the rule moves data to the archive tier. A transition shorter than the read age makes hot reads pay retrieval.",
    format: "count" as const,
  },
  {
    id: "expiryDays",
    label: "Expire after",
    min: 30,
    max: 730,
    step: 5,
    value: 730,
    unit: " days",
    group: "Lifecycle",
    help: "Object age when the rule deletes data. Expiry is permanent and has no restore path unless versioning or a backup exists.",
    format: "count" as const,
  },
  {
    id: "readAgeDays",
    label: "Age of data read",
    min: 1,
    max: 365,
    step: 1,
    value: 30,
    unit: " days",
    group: "Access",
    help: "Typical age of the objects the workload reads. Reads that reach past the transition age hit the archive tier.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function daysAt(t: number): number {
  return t * (365 / YEAR_SECONDS);
}

interface Computed {
  days: number;
  ingest: number;
  transition: number;
  expiry: number;
  readAge: number;
  standardTb: number;
  archiveTb: number;
  expiredTb: number;
  totalTb: number;
  costIndex: number;
  retrievalLatency: number;
  retrievalRequests: number;
  expiredReads: number;
  archivedRead: boolean;
  expiredRead: boolean;
}

function compute(p: Params, t: number): Computed {
  const days = daysAt(t);
  const ingest = Math.max(1, num(p, "ingestGbPerDay", 100));
  const expiry = Math.max(1, num(p, "expiryDays", 730));
  const transition = clamp(num(p, "transitionDays", 180), 1, expiry);
  const readAge = Math.max(1, num(p, "readAgeDays", 30));
  const standardDays = Math.min(days, transition, expiry);
  const archiveDays = Math.max(0, Math.min(days, expiry) - transition);
  const expiredDays = Math.max(0, days - expiry);
  const standardTb = (ingest * standardDays) / 1_000;
  const archiveTb = (ingest * archiveDays) / 1_000;
  const expiredTb = (ingest * expiredDays) / 1_000;
  const totalTb = standardTb + archiveTb;
  const effectiveAge = Math.min(readAge, days);
  const archivedRead = effectiveAge > transition && effectiveAge <= expiry;
  const expiredRead = effectiveAge > expiry;
  return {
    days,
    ingest,
    transition,
    expiry,
    readAge,
    standardTb,
    archiveTb,
    expiredTb,
    totalTb,
    costIndex: standardTb + archiveTb * ARCHIVE_RATIO,
    retrievalLatency: archivedRead ? Math.min(6_040, 40 + (effectiveAge - transition) * 100) : 40,
    retrievalRequests: archivedRead ? READ_RATE : 0,
    expiredReads: expiredRead ? READ_RATE : 0,
    archivedRead,
    expiredRead,
  };
}

function serviceHealth(values: Computed): "ok" | "warn" | "crit" {
  if (values.retrievalLatency >= 6_000 || values.expiredReads >= 100) return "crit";
  if (values.retrievalLatency >= 500 || values.retrievalRequests >= 1_000 || values.expiredReads >= 10) {
    return "warn";
  }
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metricSeed: [string, number, number][] = [
    ["retrieval-latency", values.retrievalLatency, 2],
    ["retrieval-requests", values.retrievalRequests, 5],
    ["expired-reads", values.expiredReads, 1],
    ["standard-tb", values.standardTb, 0.05],
    ["archive-tb", values.archiveTb, 0.05],
    ["storage-index", values.costIndex, 0.05],
  ];
  for (const [id, value, amplitude] of metricSeed) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * (0.99 + 0.01 * Math.sin((index + (seed % 4)) / 3.3)) + amplitude * Math.sin(index / 2.7)),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(
  p: Params,
  seed: number,
  values: Computed,
  state: { transitioned: boolean; hotRead: boolean; expiredReadEvent: boolean },
): SimFrame {
  const health = serviceHealth(values);
  const archiveHealth: "ok" | "warn" | "crit" =
    values.archivedRead && values.retrievalLatency >= 6_000
      ? "crit"
      : values.archivedRead
        ? "warn"
        : "ok";
  const expiryHealth: "ok" | "crit" = values.expiredRead ? "crit" : "ok";
  const share = (part: number) => (values.totalTb > 0 ? clamp(part / values.totalTb) : 0);
  return {
    t: 0,
    nodes: [
      {
        id: "readers",
        label: "Readers",
        kind: "client",
        health,
        sublabel: `${READ_RATE.toLocaleString("en-US")} reads/day · age ${Math.round(Math.min(values.readAge, values.days))}d`,
        meta: { view: "flow" },
      },
      {
        id: "bucket",
        label: "Object bucket",
        kind: "storage",
        health,
        utilization: share(values.standardTb + values.archiveTb),
        sublabel: `${values.totalTb.toFixed(1)} TB · ${values.ingest} GB/day in`,
        detail: `Lifecycle moves objects after ${values.transition} days and expires them after ${values.expiry} days. Reads target objects about ${values.readAge} days old.`,
        meta: { view: "flow" },
      },
      {
        id: "standard",
        label: "Standard tier",
        kind: "storage",
        health: "ok",
        utilization: share(values.standardTb),
        sublabel: `${values.standardTb.toFixed(1)} TB · full latency`,
        detail: "Recent objects stay in the standard tier and serve reads at normal latency.",
        meta: { view: "flow" },
      },
      {
        id: "archive",
        label: "Archive tier",
        kind: "storage",
        health: archiveHealth,
        utilization: share(values.archiveTb),
        sublabel: `${values.archiveTb.toFixed(1)} TB · ${values.archivedRead ? "read now" : "cold"}`,
        detail: "Archive storage is cheaper per GB-month and charges for retrieval. A read that lands here pays the retrieval path.",
        meta: { view: "flow" },
      },
      {
        id: "expired",
        label: "Expired objects",
        kind: "storage",
        health: expiryHealth,
        utilization: share(values.expiredTb),
        sublabel: `${values.expiredTb.toFixed(1)} TB deleted · ${values.expiredReads.toLocaleString("en-US")} misses/day`,
        detail: "Expiry deletes objects. A read that targets an expired age returns a miss; there is no lifecycle transition that brings it back.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("readers-bucket", "readers", "bucket", 0.8, health),
      edge("bucket-standard", "bucket", "standard", share(values.standardTb), "ok"),
      edge("bucket-archive", "bucket", "archive", share(values.archiveTb), archiveHealth),
      edge("archive-expired", "archive", "expired", share(values.expiredTb), expiryHealth),
    ],
    metrics: [
      metric("retrieval-latency", "Retrieval latency", values.retrievalLatency, "ms", 500, 6_000, "ms"),
      metric("retrieval-requests", "Archive retrievals", values.retrievalRequests, " requests/day", 1_000, 2_500, "count"),
      metric("expired-reads", "Reads on expired data", values.expiredReads, " requests/day", 10, 100, "count"),
      metric("standard-tb", "Standard tier", values.standardTb, " TB", undefined, undefined, "number"),
      metric("archive-tb", "Archive tier", values.archiveTb, " TB", undefined, undefined, "number"),
      metric("storage-index", "Storage index", values.costIndex, " TB-eq", undefined, undefined, "number"),
      metric("expired-tb", "Expired data", values.expiredTb, " TB", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      transitioned: state.transitioned ? 1 : 0,
      hotRead: state.hotRead ? 1 : 0,
      expiredReadEvent: state.expiredReadEvent ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.totalTb.toFixed(1)} TB stored: ${values.standardTb.toFixed(1)} TB standard and ${values.archiveTb.toFixed(1)} TB archive. Reads target ${Math.round(Math.min(values.readAge, values.days))}-day-old objects at ${Math.round(values.retrievalLatency)}ms.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const values = compute(p, 0);
  const frame = buildFrame(p, seed, values, {
    transitioned: false,
    hotRead: false,
    expiredReadEvent: false,
  });
  seedSeries(frame, values, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "retrieval-latency",
    metricId: "retrieval-latency",
    warn: 500,
    crit: 6_000,
    title: "Reads are paying the archive retrieval path",
    cause:
      "Objects were transitioned to an archive tier before the workload stopped reading them. Archive storage is cheaper to hold and slower or more expensive to read; the transition point is shorter than the read age.",
    fix:
      "Move the transition later than the read age, scope the rule to a prefix that is genuinely cold, or keep the working set in a tier with normal retrieval. Use storage class analysis rather than an assumed age.",
    checkFirst: [
      "Compare the transition age with the age of the objects the workload reads.",
      "Check whether the rule applies to the whole bucket or only to a cold prefix.",
      "Check whether the archive class supports the retrieval latency the workload needs.",
    ],
  },
  {
    id: "retrieval-requests",
    metricId: "retrieval-requests",
    warn: 1_000,
    crit: 2_500,
    title: "Archive retrieval volume is rising",
    cause:
      "A large share of reads is reaching objects in the archive tier. Each retrieval adds a request and a retrieval charge on top of the cheaper storage rate, so the storage saving can be erased by access cost.",
    fix:
      "Delay the transition, exclude hot prefixes, or use an infrequent-access class instead of an archive class. Re-measure the access pattern before moving more data.",
    checkFirst: [
      "Split reads by object age and prefix to find the hot set.",
      "Compare retrieval volume with the storage saving.",
      "Check whether the rule applies to objects that are still being written or indexed.",
    ],
  },
  {
    id: "expired-reads",
    metricId: "expired-reads",
    warn: 10,
    crit: 100,
    title: "The lifecycle rule is deleting data the workload still reads",
    cause:
      "The expiry age is shorter than the age of objects the workload still requests. Expiry is a delete, not a transition; the read returns a miss and the data may be unrecoverable without versioning or a backup.",
    fix:
      "Move the expiry later, scope it to a cold prefix, or add versioning and a backup before shortening it. Test the rule on non-production data with the real access pattern.",
    checkFirst: [
      "Compare the expiry age with the maximum age of objects the workload reads.",
      "Check whether versioning or a backup can restore a deleted object.",
      "Check whether the rule was recently shortened or applied to a broader prefix.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const storageLifecycleModel: SimModel = {
  id: "capacity-storage-lifecycle",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const t = frame.t;
    let transitioned = fresh ? false : frame.flags.transitioned === 1;
    let hotRead = fresh ? false : frame.flags.hotRead === 1;
    let expiredReadEvent = fresh ? false : frame.flags.expiredReadEvent === 1;
    const values = compute(p, t);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), values, {
      transitioned,
      hotRead,
      expiredReadEvent,
    });
    next.t = frame.t;
    if (!fresh) next.series = frame.series;
    next.events = frame.events;

    if (!transitioned && values.archiveTb > 0) {
      pushEvent(next, {
        id: "objects-transitioned",
        at: t,
        severity: "info",
        title: "Objects crossed the transition age",
        detail: `About ${values.archiveTb.toFixed(1)} TB is now in the archive tier after ${values.transition} days. The cheaper storage rate starts here.`,
        nodeId: "archive",
        metricId: "archive-tb",
      });
      transitioned = true;
    }

    if (!hotRead && values.archivedRead) {
      pushEvent(next, {
        id: "hot-read-archived",
        at: t,
        severity: values.retrievalLatency >= 6_000 ? "crit" : "warn",
        title: "A read is hitting the archive tier",
        detail: `Objects about ${Math.round(Math.min(values.readAge, values.days))} days old are read, and the transition is at ${values.transition} days. Retrieval latency is ${Math.round(values.retrievalLatency)}ms.`,
        nodeId: "archive",
        metricId: "retrieval-latency",
      });
      hotRead = true;
    }

    if (!expiredReadEvent && values.expiredRead) {
      pushEvent(next, {
        id: "read-expired-object",
        at: t,
        severity: "crit",
        title: "A read is targeting an expired object",
        detail: `The read age is ${values.readAge} days and the expiry is ${values.expiry} days. The object is already deleted.`,
        nodeId: "expired",
        metricId: "expired-reads",
      });
      expiredReadEvent = true;
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      transitioned: transitioned ? 1 : 0,
      hotRead: hotRead ? 1 : 0,
      expiredReadEvent: expiredReadEvent ? 1 : 0,
      paramsKey: key,
      seed: Number(frame.flags.seed ?? 20261110),
    };

    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const items = [
      `${value("standard-tb").toFixed(1)} TB is in standard storage and ${value("archive-tb").toFixed(1)} TB is in the archive tier. The storage index is ${value("storage-index").toFixed(1)} TB-equivalent.`,
      `Retrieval latency is ${Math.round(value("retrieval-latency"))}ms and archive retrieval is ${Math.round(value("retrieval-requests")).toLocaleString("en-US")} requests/day. The transition is only cheap if the read age stays below it.`,
      "A lifecycle rule is a bet about future access. The bet is wrong when the transition is earlier than the read age, or the expiry is earlier than the retention requirement.",
    ];
    if (value("expired-reads") > 0) {
      items.push("Expiry is deleting objects that are still read. Check versioning and backups before shortening the rule further.");
    }
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
    description: "A 180-day transition and 30-day read age keep the hot working set in standard storage.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Transition too early",
    description: "A 60-day transition against 90-day reads; storage is cheaper and retrievals are now a line item.",
    tone: "warn",
    params: defaults({ ingestGbPerDay: 200, transitionDays: 60, expiryDays: 365, readAgeDays: 90 }),
  },
  {
    id: "failure",
    label: "Hot data in the archive",
    description: "A 7-day transition against 90-day reads; the working set is archived and retrieval latency is critical.",
    tone: "crit",
    params: defaults({ ingestGbPerDay: 100, transitionDays: 7, expiryDays: 365, readAgeDays: 90 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A 365-day transition keeps the 30-day working set in standard storage; reads stay fast.",
    tone: "ok",
    params: defaults({ ingestGbPerDay: 100, transitionDays: 365, expiryDays: 730, readAgeDays: 30 }),
  },
];

const experiment: Experiment = {
  id: "predict-lifecycle-read",
  title: "Predict what the transition does to reads",
  simId: "storage-lifecycle",
  question:
    "A lifecycle rule moves objects to the archive tier after 7 days. The workload reads objects that are about 90 days old. What happens?",
  prediction: {
    options: [
      { id: "cheaper", label: "Storage gets cheaper and reads are unaffected" },
      { id: "archive", label: "Reads hit the archive tier and pay retrieval latency and requests" },
      { id: "back", label: "The objects move back to standard storage on the first read" },
      { id: "delete", label: "The transition deletes the objects immediately" },
    ],
    correctOptionId: "archive",
    explanation:
      "A lifecycle transition changes the storage class of objects at a certain age; it does not know which objects are still read. If the workload reads 90-day-old objects and the transition is at 7 days, those reads land in the archive tier. Archive storage is cheaper per GB-month, but each retrieval has a request and latency cost. The object does not move back to standard storage because it was read.",
  },
  setup: defaults({ ingestGbPerDay: 100, transitionDays: 7, expiryDays: 365, readAgeDays: 90 }),
  runFor: 45,
  observe: [
    "Objects transition seven days after they are written, long before the workload stops reading them.",
    "At 90 days of read age, reads hit the archive tier instead of standard storage.",
    "Retrieval latency rises to seconds and archive retrieval requests become a daily cost.",
    "Storage per GB falls, but the access path is now the expensive part.",
  ],
  explain:
    "Lifecycle rules optimize storage cost by age, not by access frequency. That works when age and coldness line up. It fails when a workload reads a stable, older working set. The fix is to move the transition beyond the read age, scope the rule to a prefix that is actually cold, or use a storage class whose retrieval behavior matches the access pattern.",
  fix: defaults({ ingestGbPerDay: 100, transitionDays: 365, expiryDays: 730, readAgeDays: 30 }),
  debrief:
    "With the transition at 365 days, the 30-day working set stays in standard storage and reads remain fast. Storage carries more GB at the standard rate, but the retrieval cost and latency disappear. The trade is higher storage cost against lower access cost, which is the right side of the trade when the data is actually hot. All ratios in this model are illustrative.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An object lifecycle policy is a set of rules that change an object's storage class or delete it when it reaches an age, a date, or a number of versions. A transition moves the object to a cheaper storage class. An expiration deletes it. The rules are evaluated by the storage service on a schedule; they do not know whether the object is still being read. That is the entire trade: storage cost falls with age, and access cost rises when a read lands in a colder tier.",
  },
  {
    type: "p",
    text: "Storage classes differ in more than price per GB-month. Infrequent-access classes are cheaper to store and charge for retrieval; archive classes are cheaper still and can take minutes or hours to retrieve depending on the class. Some classes have a minimum storage duration, so transitioning an object and then deleting it early can still incur a charge for the minimum period. A lifecycle rule that looks like a pure saving on the storage line can add a retrieval line and a latency problem.",
  },
  {
    type: "p",
    text: "The two ages that matter are the transition age and the read age. If the workload reads objects that are younger than the transition, it never touches the cold tier. If it reads objects that are older, every read pays the colder tier's retrieval path. The gap between the two is the risk. Expiry adds a harder failure: a read after expiry is a miss, and the object is gone unless versioning or a backup can restore it.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The lifecycle configuration sits on the bucket, above the objects and below the workload. Writers add objects; readers request them by key. The rule runs on the service side and changes the object's class without consulting the reader. A cache or a metadata index can hide the transition for a while, but a cache miss reaches the storage tier and pays the retrieval cost.",
  },
  {
    type: "table",
    headers: ["Access pattern", "Transition", "Read effect", "Right move"],
    rows: [
      ["Reads only recent data", "After the read age", "No change", "Keep the transition, monitor the age"],
      ["Reads a stable older working set", "Before the read age", "Archive retrieval on every miss", "Move the transition later or exclude the prefix"],
      ["Rare compliance reads", "Early", "Slow retrieval is acceptable", "Archive is a good fit"],
      ["Data never read again", "Early, then expire", "No reads to break", "Expire on the retention schedule"],
    ],
  },
  {
    type: "p",
    text: "The model compresses one year into 60 simulated seconds and uses a fixed read rate of 2,000 requests per day. It tracks standard and archive terabytes, retrieval latency, and expired reads. The storage index uses an illustrative 0.4 ratio for archive storage; it is not an AWS price. The point is the shape of the trade, not a bill.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Standard and archive terabytes as objects age through the rules.",
      "Retrieval latency for reads that land in the archive tier.",
      "Archive retrieval requests per day, the access cost that offsets the storage saving.",
      "Reads on expired data, which are misses rather than slow successes.",
      "The storage index, an illustrative standard-equivalent measure of stored data.",
      "A flow from readers to bucket to standard, archive, and expired objects.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply Transition too early. Watch the archive tier grow and retrieval latency rise while storage gets cheaper. Run the guided experiment before changing sliders. Then apply Hot data in the archive and compare the latency with a read that expires: one is slow and billable, the other is gone.",
  },
  { type: "sim", simId: "storage-lifecycle" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Objects were written at 100 GB per day and transitioned to the archive tier after seven days. The workload read objects that were about 90 days old. Every one of those reads landed in the archive tier, so retrieval latency rose to seconds and 2,000 requests per day paid the retrieval path. Storage became cheaper per GB-month, but the access cost and the latency moved in the wrong direction. The rule was correct about age and wrong about access.",
  },
  {
    type: "p",
    text: "In Recovery, the transition moved to 365 days. The 30-day working set stayed in standard storage, reads were fast, and the archive tier held only data that the workload no longer read. The storage index was higher than in the aggressive rule, because more data stayed in the more expensive class. That is the trade: pay to store hot data in a fast tier, or pay to retrieve it from a cold one.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "S3 Storage Lens or access logs: reads by object age and prefix, not only total request count.",
      "Lifecycle rule status and the transition/expiration actions that ran, with object counts.",
      "Retrieval requests and bytes by storage class, plus the latency distribution for archive reads.",
      "Cost and Usage Report: storage by class beside retrieval and request charges.",
      "404 or NoSuchKey rate for reads that arrive after an expiration.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the transition age with the age of the objects the workload reads. Then check whether the rule applies to the whole bucket or a cold prefix. If reads are slow but succeed, the transition is the problem. If reads fail, expiry is the problem and the data may need a restore or a backup.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the real read age by prefix before choosing a transition age.",
      "Move the transition beyond the working set, or scope the rule to a prefix that is genuinely cold.",
      "Use a storage class whose retrieval latency and cost match the access pattern.",
      "Check minimum storage duration before adding a short transition followed by an early expiry.",
      "Add versioning or a backup before shortening an expiry rule.",
      "Test the rule on a copy of production data and watch retrieval and miss rates.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "An early transition lowers storage cost and raises retrieval cost and latency for anything still read.",
      "A late transition keeps reads fast and leaves savings on the table for data that is actually cold.",
      "Expiry removes storage cost permanently and removes the data permanently; versioning and backups reduce the risk at extra cost.",
      "A broader rule is simpler to operate and more likely to catch a hot prefix by mistake.",
      "Intelligent tiering can follow access automatically and charges a monitoring fee; it is not free, and it is not a substitute for knowing the workload.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-transition",
    question:
      "How would you choose the transition age for a bucket lifecycle rule?",
    difficulty: 2,
    hints: [
      "Start from the read age, not from the storage bill.",
      "The rule applies by age, not by whether an object is hot.",
    ],
    answer:
      "I would measure the age distribution of objects that are actually read, by prefix if the bucket has different workloads. Then I would set the transition beyond the working set, or scope the rule to prefixes that are cold. I would check the retrieval cost and latency of the target class, and the minimum storage duration, before committing. After the rule runs, I would compare retrieval volume and misses with the storage saving, not just the storage line.",
    followUps: [
      "What if the access pattern changes seasonally?",
      "How would you handle a bucket with mixed workloads?",
      "When would you use intelligent tiering instead?",
    ],
    redFlags: [
      "Picks the cheapest class without checking access.",
      "Applies one rule to the whole bucket.",
      "Ignores retrieval and minimum-duration costs.",
    ],
    rubric: [
      "Measures read age.",
      "Scopes by prefix.",
      "Checks retrieval behavior.",
      "Verifies the saving after the rule runs.",
    ],
  },
  {
    id: "expiry-miss",
    question:
      "Reads started returning 404 after a lifecycle change. What do you check first?",
    difficulty: 2,
    hints: [
      "A transition changes the class; an expiration deletes the object.",
      "Check the rule action and the object age.",
    ],
    answer:
      "I would check whether the rule is an expiration rather than a transition, and compare the expiry age with the age of the objects being requested. If the rule deleted them, I would check versioning, delete markers, and backups for a restore path. I would also check whether the rule was applied to a broader prefix than intended. The fix is to restore what can be restored, then move the expiry later or narrow the scope.",
    followUps: [
      "How does versioning change the recovery path?",
      "What if the bucket has no backup?",
      "How would you test the rule before applying it?",
    ],
    redFlags: [
      "Assumes a transition can be undone by reading.",
      "Shortens the expiry again to save cost.",
      "Ignores versioning and backups.",
    ],
    rubric: [
      "Distinguishes expiry from transition.",
      "Checks versioning and backups.",
      "Checks rule scope.",
      "Moves the expiry or narrows it.",
    ],
  },
  {
    id: "retrieval-cost",
    question:
      "Storage cost fell 40% after a lifecycle change, but the total bill rose. How do you explain it?",
    difficulty: 3,
    hints: [
      "Storage and retrieval are separate lines.",
      "A cheaper class can charge for reads and have a minimum duration.",
    ],
    answer:
      "I would split the bill into storage, retrieval, and requests by storage class. The lifecycle moved data to a cheaper class, but reads that still hit that class pay retrieval and request charges. A minimum storage duration can also add a charge when objects are transitioned or deleted before the minimum. The saving on the storage line is real; the question is whether the access pattern made the retrieval line larger. The fix is to move the transition or scope it to cold prefixes.",
    followUps: [
      "Which report would you use to prove it?",
      "How would you forecast the crossover point?",
      "What would you change first?",
    ],
    redFlags: [
      "Looks only at the storage line.",
      "Assumes retrieval is free.",
      "Moves more data to the cheaper class.",
    ],
    rubric: [
      "Splits storage from retrieval and requests.",
      "Mentions minimum duration.",
      "Ties the change to access pattern.",
      "Proposes a scoped or later transition.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The read-age distribution is measured by prefix before choosing a transition age.",
      "The target storage class matches the retrieval latency and cost the workload can tolerate.",
      "Minimum storage duration and early-deletion charges are understood.",
      "Expiry has a versioning or backup path, and the restore has been tested.",
      "Lifecycle rules are scoped to prefixes, not applied blindly to the whole bucket.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether the rule transitioned or expired the objects.",
      "Compare the transition or expiry age with the age being read.",
      "Check retrieval latency and request volume by storage class.",
      "Restore expired data from versioning or backup if it is still needed.",
      "Pause or narrow the rule before it processes more objects.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Move the transition beyond the working set or scope it to cold prefixes.",
      "Re-check the total bill, including retrieval and requests.",
      "Add an alarm for archive retrieval volume and read misses.",
      "Re-test the rule on a copy of production data.",
    ],
  },
];

const references = [
  {
    title: "Managing the lifecycle of objects",
    url: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "S3 Lifecycle rules transition objects between storage classes and expire them.",
  },
  {
    title: "Transitioning objects using Amazon S3 Lifecycle",
    url: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-transition-general-considerations.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Transition behavior, storage-class constraints, and retrieval considerations.",
  },
  {
    title: "Understanding and managing Amazon S3 storage classes",
    url: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Storage classes differ in retrieval latency, retrieval cost, and minimum storage duration.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "storage-lifecycle": {
      model: storageLifecycleModel,
      presets,
      instructions:
        "Start healthy, apply Transition too early, then compare Recovery. Watch archive terabytes, retrieval latency, and retrieval requests together.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The archive storage ratio and request volume are teaching values, not AWS prices.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-caching-strategies",
    "capacity-cost-per-request",
    "capacity-unit-economics",
    "capacity-rightsizing",
  ],
};
