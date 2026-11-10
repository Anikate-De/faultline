import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "mode",
    label: "Encryption mode",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Path",
    help: "0 calls KMS Encrypt for every object. 1 uses envelope encryption: KMS protects a data key, and the data key encrypts objects.",
    format: "count" as const,
  },
  {
    id: "objects",
    label: "Object rate",
    min: 100,
    max: 2_000,
    step: 100,
    value: 500,
    unit: " objects/s",
    group: "Traffic",
    help: "Objects written per second. Each object is one bulk encryption operation regardless of size.",
    format: "rps" as const,
  },
  {
    id: "reuse",
    label: "Objects per data key",
    min: 1,
    max: 1_000,
    step: 50,
    value: 500,
    unit: " objects",
    group: "Envelope",
    help: "How many objects share one cached data key. Higher reuse lowers KMS calls but increases the volume protected by one key.",
    format: "count" as const,
  },
  {
    id: "quota",
    label: "KMS request quota",
    min: 50,
    max: 3_000,
    step: 50,
    value: 800,
    unit: " req/s",
    group: "KMS",
    help: "Illustrative request capacity for the key. Real KMS quotas depend on the API operation, Region, and account.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  envelope: boolean;
  objects: number;
  reuse: number;
  quota: number;
  kmsCalls: number;
  utilization: number;
  throttle: number;
  latency: number;
  cost: number;
  kmsHealth: Health;
  appHealth: Health;
}

function compute(p: Params): Computed {
  const envelope = num(p, "mode", 1) >= 0.5;
  const objects = Math.max(1, num(p, "objects", 500));
  const reuse = Math.max(1, Math.round(num(p, "reuse", 500)));
  const quota = Math.max(1, num(p, "quota", 800));
  const kmsCalls = envelope ? objects / reuse : objects;
  const utilization = kmsCalls / quota;
  const throttle = utilization > 1 ? (1 - 1 / utilization) * 100 : 0;
  const latency = envelope
    ? 6 + Math.max(0, utilization - 1) * 60
    : 20 + Math.max(0, utilization - 1) * 80;
  const cost = envelope ? 0.03 + 3 / reuse : 3;
  const risk = throttle >= 2 || latency >= 200;
  return {
    envelope,
    objects,
    reuse,
    quota,
    kmsCalls,
    utilization,
    throttle,
    latency,
    cost,
    kmsHealth: risk ? "crit" : throttle > 0 || latency >= 50 ? "warn" : "ok",
    appHealth: risk ? "crit" : latency >= 50 ? "warn" : "ok",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatRate(value: number): string {
  return value >= 10 ? Math.round(value).toString() : value.toFixed(1);
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const rows: [string, number, number][] = [
    ["kms-throttle", values.throttle, 0],
    ["encrypt-latency", values.latency, 1],
    ["kms-calls", values.kmsCalls, 0.4],
    ["cost", values.cost, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) => {
      const wave = Math.sin((index + (seed % 6)) / 2.7) * amplitude;
      return Math.max(0, value + wave);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "writer",
        kind: "service",
        health: values.appHealth,
        sublabel: `${formatCount(values.objects)} objects/s`,
        detail:
          values.throttle > 0
            ? `The writer is waiting on KMS. ${Math.round(values.throttle)}% of key requests are above the modeled quota, so retries add latency before the object is written.`
            : "The writer completes each object at the latency of the selected path.",
        meta: { view: "flow" },
      },
      {
        id: "kms",
        label: "KMS key",
        kind: "external",
        health: values.kmsHealth,
        utilization: clamp(values.utilization / 4),
        sublabel: `${formatRate(values.kmsCalls)} req/s · quota ${formatCount(values.quota)}`,
        detail:
          values.envelope
            ? "KMS generates or decrypts a data key. The key policy must allow the caller, but bulk object bytes never go through KMS."
            : "KMS encrypts the object payload directly. Every object is one API request, so the request quota becomes the write throughput limit.",
        meta: { view: "flow", mode: values.envelope ? "envelope" : "direct" },
      },
      {
        id: "datakey",
        label: "data key cache",
        kind: "cache",
        health: values.envelope ? (values.throttle > 0 ? "warn" : "ok") : "down",
        sublabel: values.envelope ? `1 key / ${formatCount(values.reuse)} objects` : "not used",
        detail: values.envelope
          ? "A cached plaintext data key encrypts objects locally. The wrapped key is stored with the object so a reader can unwrap it through KMS."
          : "The direct path has no data key. Each object requires a KMS API call and a key-policy evaluation.",
        meta: { view: "flow" },
      },
      {
        id: "s3",
        label: "s3://events-prod",
        kind: "storage",
        health: "ok",
        sublabel: "SSE-KMS",
        detail:
          "The bucket stores ciphertext. Slow writes come from the key path, not from S3 capacity. The object metadata records which key protected it.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-kms", "app", "kms", clamp(values.kmsCalls / Math.max(values.quota, values.kmsCalls)), values.kmsHealth),
      edge("app-datakey", "app", "datakey", values.envelope ? 1 : 0, values.envelope ? "ok" : "down"),
      edge("datakey-s3", "datakey", "s3", values.envelope ? 1 : 0, values.envelope ? "ok" : "down"),
      edge("kms-s3", "kms", "s3", values.envelope ? 0.1 : 1, values.kmsHealth),
    ],
    metrics: [
      metric("kms-throttle", "KMS throttled", values.throttle, "%", 0.5, 2, "percent"),
      metric("encrypt-latency", "Write latency", values.latency, " ms", 50, 200, "ms"),
      metric("kms-calls", "KMS requests", values.kmsCalls, " req/s", undefined, undefined, "rps"),
      metric("cost", "Key cost index", values.cost, " $/M objects", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatCount(values.objects)} objects/s; ${formatRate(values.kmsCalls)} KMS req/s; ${Math.round(
      values.latency,
    )} ms write; ${values.envelope ? "envelope" : "direct"}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "kms-throttle",
    metricId: "kms-throttle",
    warn: 0.5,
    crit: 2,
    title: "KMS is throttling the encryption path",
    cause:
      "The workload is issuing more key requests than the modeled quota. A direct call per object makes the quota the write-rate ceiling; retries and backoff turn throttling into latency.",
    fix:
      "Move bulk data to envelope encryption, cache a data key for a bounded number of objects, and request a quota increase only for the key operations that still need per-request calls.",
    checkFirst: [
      "Read the KMS request rate and throttle rate before changing S3 or the writer.",
      "Confirm whether the path calls Encrypt per object or uses GenerateDataKey plus a local cipher.",
      "Check the key policy and grants for a separate authorization failure hidden behind retries.",
    ],
  },
  {
    id: "encrypt-latency",
    metricId: "encrypt-latency",
    warn: 50,
    crit: 200,
    title: "Write latency is dominated by the key path",
    cause:
      "Every object waits on a KMS response. With direct calls, latency tracks the key service and its quota. With envelope encryption, only data-key creation or unwrap touches KMS.",
    fix:
      "Use envelope encryption, reuse the data key within its allowed lifetime, cache unwrapped keys, and keep the key policy small enough to evaluate quickly.",
    checkFirst: [
      "Compare write latency with KMS request latency and throttle rate.",
      "Check whether the writer creates a new data key per object instead of reusing a cached one.",
      "Confirm the bucket is not waiting on a separate replication or lifecycle path.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const kmsModel: SimModel = {
  id: "cloud-networking-kms",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    const jitter = rng.between(-1.5, 1.5);
    next.metrics = next.metrics.map((item) =>
      item.id === "kms-calls" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (values.throttle >= 2 && frame.flags.throttleLogged !== 1) {
      pushEvent(next, {
        id: "kms-throttled",
        severity: "crit",
        title: "KMS request quota is limiting writes",
        detail: `${formatRate(values.kmsCalls)} key requests/s exceed the modeled quota of ${formatCount(
          values.quota,
        )}. ${Math.round(values.throttle)}% of requests are throttled and retried.`,
        nodeId: "kms",
        metricId: "kms-throttle",
      });
    }
    next.flags.throttleLogged = values.throttle >= 2 ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (!values.envelope) {
      items.push(
        `The direct path makes ${formatRate(values.kmsCalls)} KMS requests/s for ${formatCount(
          values.objects,
        )} objects/s. Every object pays a key request, so KMS quota and latency become the write limit.`,
      );
    } else {
      items.push(
        `Envelope encryption makes ${formatRate(values.kmsCalls)} KMS requests/s for ${formatCount(
          values.objects,
        )} objects/s. One data key covers ${formatCount(values.reuse)} objects, so bulk bytes never touch KMS.`,
      );
    }
    items.push(
      values.throttle > 0
        ? `${Math.round(values.throttle)}% of key requests are above quota. Retries explain the latency increase; S3 is not the bottleneck.`
        : "No key requests are above quota in this state. Latency is the cost of the selected key path, not a throttle.",
    );
    items.push(
      `The key cost index is ${values.cost.toFixed(2)} dollars per million objects in this model. Reusing a data key lowers key operations but concentrates more data under one key; bound the reuse period and keep rotation in the design.`,
    );
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
    description: "Envelope encryption with one data key per 500 objects. KMS sees one request per second.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Object rate reaches 2,000/s; 100 objects per data key keeps KMS well below quota.",
    tone: "warn",
    params: defaults({ objects: 2_000, reuse: 100 }),
  },
  {
    id: "failure",
    label: "Direct KMS calls",
    description: "Every object calls KMS. The request rate is four times the modeled quota, so writes throttle and retry.",
    tone: "crit",
    params: defaults({ mode: 0, objects: 1_600, quota: 400 }),
  },
  {
    id: "no-reuse",
    label: "No data-key reuse",
    description: "Envelope encryption is enabled, but a new data key per object still floods KMS.",
    tone: "crit",
    params: defaults({ objects: 1_200, reuse: 1, quota: 800 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The writer moves to a cached data key and KMS requests fall below quota.",
    tone: "ok",
    params: defaults({ objects: 1_200, reuse: 400, quota: 400 }),
  },
];

const experiment: Experiment = {
  id: "predict-kms-quota",
  title: "Predict the first limit",
  simId: "key-path",
  question:
    "A writer stores 1,000 objects/s. It calls KMS Encrypt for every object and the modeled key quota is 400 requests/s. Storage bandwidth is healthy. What breaks first?",
  prediction: {
    options: [
      { id: "s3", label: "S3 write bandwidth, because 1,000 objects/s exceeds bucket capacity." },
      { id: "kms", label: "KMS request quota, because every object is one key request." },
      { id: "tls", label: "TLS handshakes, because each object opens a new connection." },
      { id: "key-policy", label: "The key policy, because it can only authorize one caller." },
    ],
    correctOptionId: "kms",
    explanation:
      "The direct path issues one KMS request per object. At 1,000 objects/s the key API sees 1,000 requests/s against a 400/s modeled quota. The excess is throttled and retried, so write latency rises even though the bucket has capacity. Envelope encryption moves the bulk operation to a local data key and reduces KMS calls by the reuse factor.",
  },
  setup: defaults({ mode: 0, objects: 1_000, quota: 400 }),
  runFor: 15,
  observe: [
    "KMS requests rise one-for-one with the object rate.",
    "Throttling crosses the critical line within the first seconds.",
    "Write latency rises while the bucket node stays healthy.",
    "The data-key cache is unavailable because the direct path does not use it.",
  ],
  explain:
    "The model makes the key request the unit of work. Direct encryption turns object throughput into key-API throughput. KMS quotas are per account and per operation, so a successful write path can still fail when the object rate grows. Envelope encryption separates the two rates: KMS protects the data key, and the data key handles the objects.",
  fix: defaults({ mode: 1, objects: 1_000, reuse: 500, quota: 400 }),
  debrief:
    "The better pattern is not a bigger quota by default. It is envelope encryption with a bounded data-key reuse policy, a cached unwrap path for readers, and a quota increase only for the key operations that remain per-request. The key policy, rotation, and audit trail still apply to the data key.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "AWS Key Management Service (KMS) stores and protects keys and performs small cryptographic operations. A KMS key has a key policy that decides who may use it. KMS is built for protecting keys, not for encrypting gigabytes of object data one call at a time.",
  },
  {
    type: "p",
    text: "Envelope encryption separates the two jobs. KMS generates a data key, returns a plaintext copy and a wrapped copy, and the application uses the plaintext data key to encrypt the object locally. The wrapped key is stored next to the ciphertext. A reader asks KMS to decrypt the wrapped key, then decrypts the object with the plaintext key. Bulk bytes never cross the KMS API.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "For an S3 write with server-side encryption using KMS, the request path is writer, KMS key, S3. In the direct pattern, every object is one KMS call. In the envelope pattern, one KMS call creates a data key, many objects use it, and the wrapped key travels with each object. The bucket stores ciphertext either way; the difference is how often the key service is in the hot path.",
  },
  {
    type: "table",
    headers: ["Path", "KMS calls", "Bulk data through KMS", "Limit that appears first"],
    rows: [
      ["Direct Encrypt per object", "One per object", "Yes", "KMS request quota and key latency."],
      ["Envelope, new key per object", "One per object", "No", "Still the key request rate."],
      ["Envelope, cached data key", "One per reuse window", "No", "Reuse policy, key lifetime, and cache safety."],
    ],
  },
  {
    type: "p",
    text: "The middle row is the trap. Enabling envelope encryption is not enough if the code still asks for a new data key for every object. The key request rate has to fall, and that comes from reuse or caching, not from the label on the encryption mode.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "KMS requests per second and the modeled quota.",
      "Throttle rate: the share of key requests above quota.",
      "Write latency, so a key-path delay is not mistaken for storage slowness.",
      "The data-key cache node, which is unavailable on the direct path.",
      "A key cost index per million objects, illustrating why fewer key calls also cost less.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note the gap between object rate and KMS request rate. Apply Direct KMS calls and watch write latency and throttling rise while the bucket stays healthy. Then apply No data-key reuse: envelope encryption is on, but the key rate still tracks the object rate. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "The quota, reuse counts, latency, and cost index are illustrative teaching values. Real KMS quotas depend on the API operation, Region, and account. The envelope pattern and the per-request cost model are the parts to carry into production.",
  },
  { type: "sim", simId: "key-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Direct encryption made the object rate and the KMS request rate the same number. The key quota became the write ceiling, and the extra requests were throttled and retried. Write latency rose while S3 stayed healthy, which is the signature of a key-path bottleneck.",
  },
  {
    type: "p",
    text: "Envelope encryption with a cached data key broke the one-to-one relationship. Thousands of objects per second produced a handful of KMS requests. The no-reuse preset showed that the mode alone is not the fix: a new data key per object restored the same request flood.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "KMS CloudWatch metrics and API error codes: ThrottlingException, dependency timeouts, and retry counts.",
      "Writer latency broken down by encryption step, not just total S3 PUT time.",
      "Key policy and grants: a missing kms:GenerateDataKey or kms:Decrypt permission looks like a throttle when retries hide the error.",
      "Data-key reuse policy: how long a plaintext key lives, where it is cached, and which objects share it.",
      "S3 object metadata: the key ARN and encryption context recorded with each object.",
      "Rotation state: a rotated key still decrypts old objects, but new writes use the new key version.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the KMS request rate with the object rate before changing storage capacity. If they move together, the path is making one key call per object. Check the key policy for authorization errors separately, because retries can make a deny look like a throttle.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm whether the workload calls KMS per object or uses a data key.",
      "Move bulk encryption to a data key and store the wrapped key with the ciphertext.",
      "Cache the plaintext data key for a bounded number of objects or a bounded time.",
      "Set an explicit reuse limit and clear the cache on rotation or process restart.",
      "Keep the key policy small and grant only the operations the writer and reader need.",
      "Request a quota increase for the remaining per-request operations if the workload genuinely needs it.",
      "Test the reader path, including decrypt of an object written with the previous key version.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A cached data key reduces KMS calls but protects more objects with one key. Bound the reuse window and the object count.",
      "A new data key per object is the cleanest key isolation, but it puts KMS back on the hot path at high volume.",
      "Longer key lifetimes and larger caches improve throughput but widen the window in which a leaked plaintext key is useful.",
      "Envelope encryption adds code and a wrapped-key format to the application. Managed service encryption hides that code but may still call KMS per object.",
      "A quota increase is sometimes necessary, but it does not fix a path that should not be calling KMS per object.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "explain-envelope",
    question: "Explain envelope encryption and why it is used for S3 objects.",
    difficulty: 3,
    hints: [
      "KMS protects keys, not bulk bytes.",
      "The wrapped key travels with the ciphertext.",
    ],
    answer:
      "KMS generates a data key and returns a plaintext copy plus a wrapped copy. The application encrypts the object locally with the plaintext data key, stores the wrapped key with the object, and discards the plaintext key when it is no longer needed. A reader calls KMS to decrypt the wrapped key, then decrypts the object locally. This keeps bulk bytes out of KMS, reduces key API calls, and still lets the KMS key policy and audit trail control access. The reuse policy matters: a new data key per object restores the call volume that envelope encryption was meant to remove.",
    followUps: [
      "Where is the wrapped key stored?",
      "What happens when the KMS key is rotated?",
      "How long may a plaintext data key live?",
    ],
    redFlags: [
      "Says KMS encrypts the object payload directly.",
      "Forgets the wrapped key.",
      "Believes envelope encryption removes the need for a key policy.",
    ],
    rubric: [
      "Describes data key generation and wrapping.",
      "Keeps bulk data local.",
      "Explains the reader unwrap path.",
      "Mentions reuse, rotation, and key policy.",
    ],
  },
  {
    id: "debug-throttle",
    question:
      "Writes to S3 slow down and KMS shows ThrottlingException. What do you check before requesting a quota increase?",
    difficulty: 3,
    hints: [
      "Compare the object rate with the key request rate.",
      "Envelope mode can still call KMS per object.",
    ],
    answer:
      "I would compare the object rate with the KMS request rate. If they are equal, the writer is calling KMS per object and the quota is the ceiling. I would check whether envelope encryption is enabled and whether the data key is cached or created per object. I would also check for retry amplification, a hot key shared by many writers, and a key policy that is denying calls that the client retries. A quota increase helps only the requests that must remain per-request, such as data-key creation or unwrap.",
    followUps: [
      "How would you tell a throttle from an authorization failure?",
      "Why can retries make the throttle worse?",
      "What would you change first in the writer?",
    ],
    redFlags: [
      "Requests a quota increase without reading the call pattern.",
      "Blames S3 before checking the key path.",
      "Disables encryption to restore throughput.",
    ],
    rubric: [
      "Compares object and key request rates.",
      "Checks envelope and reuse.",
      "Considers retries and key policy.",
      "Uses quota increases only for necessary calls.",
    ],
  },
  {
    id: "key-policy",
    question:
      "The writer has s3:PutObject but still gets AccessDenied on an SSE-KMS bucket. Why?",
    difficulty: 2,
    hints: [
      "S3 permission and KMS permission are separate.",
      "The key policy must allow the caller.",
    ],
    answer:
      "S3 permission controls the object write, and KMS permission controls the key operation. For an SSE-KMS upload, the caller also needs kms:GenerateDataKey on the key, and the key policy or a grant must allow it. The KMS key policy is evaluated by KMS, not by S3, so an S3 bucket policy or identity policy that allows PutObject does not grant key access. I would read the KMS error and key policy, add the narrow key permission, and test the write and read paths separately.",
    followUps: [
      "Which KMS operation is needed for an upload versus a download?",
      "When would a grant be better than a key policy statement?",
      "How does encryption context affect the grant?",
    ],
    redFlags: [
      "Adds kms:* to the role.",
      "Changes the bucket policy only.",
      "Disables SSE-KMS.",
    ],
    rubric: [
      "Separates S3 and KMS authorization.",
      "Names GenerateDataKey and Decrypt.",
      "Checks key policy or grant.",
      "Tests both directions.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Bulk data uses envelope encryption with an explicit data-key reuse policy.",
      "The reader path can unwrap keys and decrypt objects written with previous key versions.",
      "KMS request rate and throttle rate are monitored separately from storage latency.",
      "Key policies grant the narrow operations the writer and reader need.",
      "Rotation and cache invalidation are tested, not only documented.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare object rate with KMS request rate.",
      "Check throttle, retry, and authorization errors in that order.",
      "Confirm whether the writer creates a data key per object.",
      "Keep the bucket and network out of the blame path until the key path is cleared.",
      "If a quota increase is needed, request only the operations that remain per-request.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a load test at the expected object rate.",
      "Record the data-key reuse limit and the rotation procedure.",
      "Alert on key request rate relative to quota.",
      "Review key policy grants for wildcards and unused principals.",
    ],
  },
];

const references = [
  {
    title: "Envelope encryption",
    url: "https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html#enveloping",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Defines data keys, wrapping, and the envelope pattern.",
  },
  {
    title: "KMS request quotas",
    url: "https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Explains per-operation request quotas and shared quota behavior.",
  },
  {
    title: "Using server-side encryption with KMS keys",
    url: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Describes SSE-KMS permissions and the key operations S3 performs.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "key-path": {
      model: kmsModel,
      presets,
      instructions:
        "Start healthy, then compare direct KMS calls with envelope encryption and no data-key reuse. Watch KMS request rate and write latency together.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Quota, latency, reuse, and cost values are teaching values, not a KMS pricing quote.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["cloud-networking-secrets", "cloud-networking-encryption", "cloud-networking-iam-roles"],
};
