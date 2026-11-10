import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
} from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MIN_GATE_SAMPLES = 20_000;

const params: ParamSpec[] = [
  {
    id: "requestRate",
    label: "Production request rate",
    min: 2_000,
    max: 40_000,
    step: 1_000,
    value: 20_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second at full production traffic. The new version receives the next step's share of this rate.",
    format: "rps",
  },
  {
    id: "defectRate",
    label: "Latent defect rate",
    min: 0,
    max: 10,
    step: 0.5,
    value: 1,
    unit: "%",
    group: "Release",
    help: "Share of requests to the new version that fail because of a defect present in this build.",
    format: "percent",
  },
  {
    id: "currentShare",
    label: "Current traffic share",
    min: 0,
    max: 95,
    step: 1,
    value: 1,
    unit: "%",
    group: "Rollout",
    help: "Share of production traffic already on the new version before the next step.",
    format: "percent",
  },
  {
    id: "nextShare",
    label: "Next step share",
    min: 1,
    max: 100,
    step: 1,
    value: 5,
    unit: "%",
    group: "Rollout",
    help: "Share of production traffic the next step sends to the new version. A step from 25% to 100% is a 75-point jump.",
    format: "percent",
  },
  {
    id: "gateSeconds",
    label: "Gate window",
    min: 30,
    max: 600,
    step: 30,
    value: 300,
    unit: " s",
    group: "Rollout",
    help: "Time between exposure steps. The gate compares the new version with the stable version during this window.",
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
  requestRate: number;
  defect: number;
  current: number;
  next: number;
  gateSeconds: number;
  stepDelta: number;
  errors: number;
  samples: number;
  shortfall: number;
  newRps: number;
}

function compute(p: Params): Values {
  const requestRate = Math.max(1, num(p, "requestRate", 20_000));
  const defect = clamp(num(p, "defectRate", 1), 0, 100);
  const current = clamp(num(p, "currentShare", 1), 0, 100);
  const next = clamp(Math.max(current, num(p, "nextShare", 5)), 0, 100);
  const gateSeconds = Math.max(1, num(p, "gateSeconds", 300));
  const stepDelta = Math.max(0, next - current);
  const errors = defect * (next / 100);
  const newRps = requestRate * (next / 100);
  const samples = newRps * gateSeconds;
  const shortfall = Math.max(0, MIN_GATE_SAMPLES - samples);
  return { requestRate, defect, current, next, gateSeconds, stepDelta, errors, samples, shortfall, newRps };
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function level(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function pct(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

function rps(value: number): string {
  return `${Math.round(value).toLocaleString("en-US")} rps`;
}

function requests(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, seed: number, v: Values): SimFrame {
  const stepHealth = level(v.stepDelta, 10, 40);
  const errorHealth = level(v.errors, 0.25, 1);
  const sampleHealth = level(v.shortfall, 8_000, 15_000);
  const overall = worst(stepHealth, errorHealth, sampleHealth);
  const stableShare = 100 - v.next;

  const stageNodes = [
    {
      id: "stable",
      label: "Stable v1",
      kind: "service" as const,
      health: "ok" as const,
      utilization: clamp(stableShare / 100),
      throughput: v.requestRate * (stableShare / 100),
      sublabel: `${pct(stableShare)} of traffic · ${rps(v.requestRate * (stableShare / 100))}`,
      detail: `The stable version keeps ${pct(stableShare)} of traffic. The next step moves ${v.stepDelta.toFixed(0)} points to the new version and keeps the rest on v1 for comparison.`,
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "next-step",
      label: `Step to ${pct(v.next)}`,
      kind: "service" as const,
      health: overall,
      utilization: clamp(v.next / 100),
      throughput: v.newRps,
      sublabel: `gate ${v.gateSeconds}s · errors ${pct(v.errors)} · ${requests(v.samples)} samples`,
      detail: `This step puts ${pct(v.next)} of traffic on the new version, a ${v.stepDelta.toFixed(0)}-point increase. During the ${v.gateSeconds}-second gate, the new version sees ${requests(v.samples)} requests and about ${requests(v.samples * (v.defect / 100))} failures if the defect rate holds.`,
      meta: { stage: "canary", view: "deployment" },
    },
  ];

  const fullNode =
    v.next >= 100
      ? [
          {
            id: "full",
            label: "Full rollout",
            kind: "service" as const,
            health: overall,
            utilization: 1,
            throughput: v.requestRate,
            sublabel: `100% traffic · ${rps(v.requestRate)}`,
            detail: `No stable traffic remains to compare against. After this step, detection depends on absolute error and latency signals rather than a control group.`,
            meta: { stage: "full", view: "deployment" },
          },
        ]
      : [];

  const flowNodes = [
    {
      id: "clients",
      label: "Clients",
      kind: "client" as const,
      health: "ok" as const,
      sublabel: `${rps(v.requestRate)}`,
      meta: { view: "flow" },
    },
    {
      id: "service",
      label: "Checkout service",
      kind: "service" as const,
      health: overall,
      utilization: clamp(v.next / 100),
      sublabel: `${pct(v.next)} on the new version`,
      meta: { view: "flow" },
    },
    {
      id: "new-version",
      label: "New version",
      kind: "service" as const,
      health: errorHealth,
      utilization: clamp(v.next / 100),
      throughput: v.newRps,
      sublabel: `defect ${pct(v.defect)} · ${requests(v.shortfall)} sample shortfall`,
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...fullNode, ...flowNodes],
    edges: [
      edge("clients-service", "clients", "service", 1, overall),
      edge("service-new", "service", "new-version", clamp(v.next / 100), errorHealth),
    ],
    metrics: [
      metric("step-exposure", "Traffic exposed in this step", v.stepDelta, "%", 10, 40, "percent"),
      metric("errors-during-step", "Errors exposed before gate", v.errors, "%", 0.25, 1, "percent"),
      metric("gate-shortfall", "Gate sample shortfall", v.shortfall, " req", 8_000, 15_000, "count"),
      metric("gate-samples", "Gate samples collected", v.samples, " req", undefined, undefined, "count"),
      metric("new-version-rps", "New version throughput", v.newRps, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      stepDelta: v.stepDelta,
      nextShare: v.next,
      gateSeconds: v.gateSeconds,
      shortfall: v.shortfall,
      errors: v.errors,
    },
    summary: `Step ${pct(v.current)} → ${pct(v.next)} · ${v.stepDelta.toFixed(0)} points · errors ${pct(v.errors)} · ${requests(v.samples)} gate samples`,
  };
}

function seedSeries(frame: SimFrame, v: Values, seed: number): void {
  const jitter = (index: number) => 1 + 0.015 * Math.sin((index + (seed % 9)) / 2.6);
  const series: [string, number][] = [
    ["step-exposure", v.stepDelta],
    ["errors-during-step", v.errors],
    ["gate-shortfall", v.shortfall],
    ["gate-samples", v.samples],
    ["new-version-rps", v.newRps],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const model: SimModel = {
  id: "deployment-traffic-shifting",
  visual: "deployment",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(defaults(), seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const next = buildFrame(p, seed, values);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.paramsKey = key;
    next.series = reset
      ? {}
      : Object.fromEntries(Object.entries(frame.series).map(([id, series]) => [id, [...series]]));
    next.events = [...frame.events];
    if (reset) seedSeries(next, values, seed);
    const drift = 1 + rng.between(-0.002, 0.002) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "new-version-rps" ? { ...item, value: Math.max(0, item.value * drift) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds: [
    {
      id: "step-exposure",
      metricId: "step-exposure",
      warn: 10,
      crit: 40,
      title: "The next step exposes too much traffic at once",
      cause:
        "A large exposure step puts a large share of users on the new version before any gate can return a verdict. At 100% there is no stable control group left for comparison.",
      fix:
        "Split the step into smaller increments such as 1%, 5%, 25%, and 100%, and place a gate after each one. If the defect is already known, stop and roll back instead of taking another step.",
      checkFirst: [
        "Compare the planned step size with the exposure budget agreed for this release.",
        "Check whether stable traffic remains for a control comparison after the step.",
        "Check whether the previous gate actually passed, rather than timing out.",
      ],
    },
    {
      id: "errors-during-step",
      metricId: "errors-during-step",
      warn: 0.25,
      crit: 1,
      title: "The defect reaches users before the gate can act",
      cause:
        "The error share during the step multiplies the defect rate by the new version's traffic share. A 5% defect at 100% exposure is 5% of all requests, not a canary-sized problem.",
      fix:
        "Roll back or halt the sequence. Fix the defect before re-entering at a small share, and gate promotion on per-version error rate rather than the blended service rate.",
      checkFirst: [
        "Compare new-version errors with stable-version errors at the same timestamp.",
        "Check whether the error started with this step or was already present at the previous share.",
        "Check the error budget remaining for the service.",
      ],
    },
    {
      id: "gate-shortfall",
      metricId: "gate-shortfall",
      warn: 8_000,
      crit: 15_000,
      title: "The gate has too few samples to decide",
      cause:
        "A small traffic share or a short gate window produces too few requests to distinguish the new version from the control. A clean rate on a small sample is weak evidence.",
      fix:
        "Extend the gate window, raise the share within the exposure budget, or run controlled load. Decide the minimum sample before the sequence begins and fail closed when it is not met.",
      checkFirst: [
        "Check the new version's request count and the metric aggregation interval.",
        "Check whether the gate window covers a full traffic cycle.",
        "Check whether the decision used a confidence interval or only a point estimate.",
      ],
    },
  ],
  insights: (_frame, p) => {
    const v = compute(p);
    const items = [
      `The next step moves ${v.stepDelta.toFixed(0)} points of traffic, from ${pct(v.current)} to ${pct(v.next)}. That is the blast radius if the build is bad.`,
      `At a ${pct(v.defect)} defect rate, ${pct(v.errors)} of all requests fail during this step. The defect affects only the new version's share, but that share is what users see.`,
      `The ${v.gateSeconds}-second gate collects ${requests(v.samples)} requests from the new version against an illustrative minimum of ${requests(MIN_GATE_SAMPLES)}.`,
    ];
    if (v.next >= 100) {
      items.push("At 100%, the stable control group is gone. Later detection must rely on absolute signals, not a version-to-version comparison.");
    } else {
      items.push(`About ${pct(100 - v.next)} of traffic stays on the stable version for comparison during the gate.`);
    }
    items.push("A larger step exposes more users but produces more samples per gate. A smaller step limits exposure but needs a longer window to reach the same confidence.");
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
    description: "A 1% to 5% step on a clean build with a five-minute gate.",
    tone: "ok",
    params: defaults({ currentShare: 1, nextShare: 5 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "30k rps, a 5% to 25% step, and a 2% defect. Exposure and errors enter the warning band.",
    tone: "warn",
    params: defaults({ requestRate: 30_000, defectRate: 2, currentShare: 5, nextShare: 25, gateSeconds: 120 }),
  },
  {
    id: "failure",
    label: "One big step",
    description: "A 5% to 100% jump with a 5% defect and a 60-second gate.",
    tone: "crit",
    params: defaults({ requestRate: 24_000, defectRate: 5, currentShare: 5, nextShare: 100, gateSeconds: 60 }),
  },
  {
    id: "short-gate",
    label: "Short gate",
    description: "A small 1% to 5% step at low traffic with a 30-second window.",
    tone: "crit",
    params: defaults({ requestRate: 2_000, defectRate: 1, currentShare: 1, nextShare: 5, gateSeconds: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The defect is fixed and the rollout resumes with a 1% to 10% step and a full gate.",
    tone: "ok",
    params: defaults({ requestRate: 24_000, defectRate: 1, currentShare: 1, nextShare: 10, gateSeconds: 300 }),
  },
];

const experiment: Experiment = {
  id: "predict-big-step",
  title: "Predict what one big step exposes",
  simId: "traffic-shifting",
  question:
    "You jump from 5% to 100% with a 60-second gate. The build has a 5% defect. Which failure comes first?",
  prediction: {
    options: [
      { id: "exposure", label: "Every user sees the defect immediately, before the gate can decide" },
      { id: "samples", label: "The gate cannot collect enough samples to decide" },
      { id: "stable", label: "The stable version starts returning errors" },
      { id: "nothing", label: "Nothing fails because 60 seconds is a long enough gate" },
    ],
    correctOptionId: "exposure",
    explanation:
      "A 100% step removes the stable comparison and sends the defect to every request. The gate gets plenty of samples, but the decision arrives after the exposure. Sample size is not the constraint; blast radius is.",
  },
  setup: defaults({ requestRate: 24_000, defectRate: 5, currentShare: 5, nextShare: 100, gateSeconds: 60 }),
  runFor: 20,
  observe: [
    "The step exposes 95 points of traffic at once.",
    "Errors during the step reach 5% of all requests.",
    "The gate has more than a million samples, so a sample-size gate would not stop it.",
    "The stable version is no longer carrying traffic for comparison.",
  ],
  explain:
    "Traffic shifting trades blast radius for detection speed. A large step produces samples quickly but exposes users before the gate can act. A small step limits exposure but needs enough traffic and time to reach a confident decision.",
  fix: defaults({ requestRate: 24_000, defectRate: 1, currentShare: 1, nextShare: 10, gateSeconds: 300 }),
  debrief:
    "The fixed sequence uses a 10-point step on a clean build: errors fall to 0.1% and the gate still collects 720k samples. The cost is more steps and more wall-clock time. That is the trade: a smaller step buys a smaller blast radius with slower progress, and the gate window must be long enough for the smaller sample to mean something.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Traffic shifting is a rollout that moves production traffic to a new version in steps. Each step changes the share, then a gate observes the new version for a window before the next step. The sequence 1%, 5%, 25%, 100% is a common shape, but the numbers matter less than the rule: no step without a gate, and no step larger than the exposure budget.",
  },
  {
    type: "p",
    text: "The gate compares the new version with the stable version on error rate, latency, saturation, and capacity. The step size sets the blast radius if the build is bad. The gate window and traffic share set how many samples the gate sees. Those two goals pull in opposite directions: a larger step produces a verdict quickly but exposes more users, while a smaller step limits exposure but needs more time to distinguish a real regression from noise.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The load balancer or service mesh owns the traffic split. The deployment controller advances the sequence when the gate passes and stops when it fails. The same mechanism appears in Kubernetes canary controllers, service mesh traffic policies, and cloud deployment services. The stable version remains the control until the final step; losing that control changes how you detect a failure.",
  },
  {
    type: "table",
    headers: ["Step", "New exposure", "What the gate has", "Main risk"],
    rows: [
      ["1%", "1% of requests", "A thin slice; sample count depends on traffic", "Rare defects and small samples"],
      ["5%", "5% of requests", "A small but comparable slice", "A rare defect stays hidden"],
      ["25%", "25% of requests", "Enough samples for most signals", "A quarter of users see the defect"],
      ["100%", "Every request", "No control group", "Full blast radius before rollback"],
    ],
  },
  {
    type: "p",
    text: "The values in this module are illustrative teaching values. The request rate, defect rate, sample minimum, and thresholds are not provider guarantees. The shape is the lesson: exposure grows with the step, while the gate's evidence grows with share and time.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Step exposure: the points of traffic added in this step, which is the blast radius.",
      "Errors before gate: the share of all requests that fail while the gate is still deciding.",
      "Gate samples and shortfall: whether the new version saw enough requests to support a decision.",
      "New version throughput in requests per second, so exposure is not confused with a request count.",
      "A deployment view of stable, next-step, and full stages with the current share.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply One big step. Watch errors jump while the sample count stays healthy: the gate is not short of data, it is short of time and unexposed users. Apply Short gate to see the opposite failure, then Recovery to see a fixed build moved in a small step.",
  },
  {
    type: "p",
    text: "A step plan is a budget. Decide how many users may see a bad build before the gate acts, then choose the largest step that fits. If the gate cannot reach a decision in the available window, do not promote on a clean point estimate; extend the window or use controlled load. The final step needs special care because it removes the control group and any remaining defect reaches everyone.",
  },
  { type: "sim", simId: "traffic-shifting" },
  { type: "experiment", experimentId: "predict-big-step" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the One big step preset, the sequence jumped from 5% to 100%. The step exposed 95 points of traffic at once, and a 5% defect became 5% of all requests. The gate collected more than a million samples, so it had plenty of evidence, but the evidence arrived after the users were exposed. In the Short gate preset, the opposite happened: the step was small and the window was short, so the gate had only 3,000 samples against an illustrative 20,000 minimum.",
  },
  {
    type: "p",
    text: "The Recovery preset fixes the build and resumes at 1% to 10% with a five-minute gate. Errors fall to 0.1% and the gate sees 720k samples. The rollout is slower, but each step stays inside a smaller exposure budget.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Deployment events for each traffic shift, with the old and new share and the gate result.",
      "Per-version error rate, p99 (99th-percentile) latency, and request count from the load balancer or mesh.",
      "Saturation and capacity signals for shared dependencies at the current share.",
      "Gate timeouts, overrides, and manual stops, which often reveal a gate that cannot decide.",
      "Error budget burn for the service, not just the new version's raw error rate.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the size of the step before checking the dashboard. If the step is large, assume the users are already exposed and decide whether to stop or roll back. Then check whether the gate has enough samples to support the last promotion, and whether stable traffic still exists for comparison.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the sequence at the current share or roll back if the error budget is at risk.",
      "Preserve the per-version metrics and deployment events for the review.",
      "Fix the defect or reduce the per-request work before re-entering.",
      "Set an exposure budget and choose a step size that fits it.",
      "Size the gate window from the sample needed to detect the smallest regression you care about.",
      "Keep a stable control group until the final step, and treat 100% as a one-way door.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Large steps reach a decision quickly but expose more users before the gate can act.",
      "Small steps limit blast radius but need more wall-clock time and more total gate windows.",
      "Long gate windows improve confidence but slow delivery and can cross a traffic cycle.",
      "A 100% step simplifies operations but removes the control group that makes comparison cheap.",
      "Automatic promotion is faster but can advance a step whose gate never reached enough samples.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "sequence",
    question:
      "Design a traffic-shifting sequence for a service at 8,000 requests per second with a new checkout path. What steps, gates, and stop conditions do you use?",
    difficulty: 2,
    hints: [
      "Start from the exposure budget, not from a familiar percentage.",
      "Each gate needs a sample target and a comparison.",
      "Say what happens when a gate cannot decide.",
    ],
    answer:
      "I would start at 1% or the smallest share that produces enough samples, hold for a full traffic cycle, and compare per-version error rate, p99, and saturation with the stable version. If the gate passes, I would move to 5%, then 25%, then 100%, with the same gate at each step. At 8,000 rps, 1% for ten minutes gives 48,000 requests, which is enough for a coarse error check but not for a rare tail defect; I would extend the window or accept a larger first step based on the risk. I would stop on a per-version error or latency budget breach, insufficient samples, or a failed dependency check, and I would roll back if the defect is already confirmed.",
    followUps: [
      "Which step would you make the longest, and why?",
      "How does a low-traffic service change the sequence?",
      "What would make you skip the 25% step?",
    ],
    redFlags: [
      "Picks percentages without a sample calculation.",
      "Uses only the blended service error rate.",
      "Promotes when a gate times out.",
    ],
    rubric: [
      "Defines an exposure budget and step sequence.",
      "Sizes gates from traffic and window.",
      "Compares against a stable control.",
      "Defines stop and rollback conditions.",
    ],
  },
  {
    id: "big-step",
    question:
      "An engineer proposes going from 5% to 100% because the canary has been clean for an hour. What is your response?",
    difficulty: 2,
    hints: [
      "The canary's clean result covers only the traffic it saw.",
      "The final step removes the control group.",
      "A defect rate can be small and still affect many users at full scale.",
    ],
    answer:
      "I would ask what the hour at 5% actually proves. It covers 5% of requests and likely only the happy paths that reached that slice. At 100%, every request and every code path is exposed, and the stable comparison disappears. A defect that affects 1% of requests would hit every user group at full traffic and could be invisible in a small canary. I would keep the staged sequence, add a capacity or saturation check at the target scale, and only take the final step with a tested rollback path.",
    followUps: [
      "What would you measure at 25% that you cannot measure at 5%?",
      "How would you test capacity without exposing users?",
      "When is a direct 100% deploy defensible?",
    ],
    redFlags: [
      "Treats canary duration as proof of full-scale safety.",
      "Ignores the loss of the control group.",
      "Has no rollback plan for the final step.",
    ],
    rubric: [
      "Explains the limits of the canary sample.",
      "Names full-scale capacity and shared dependencies.",
      "Keeps a staged sequence or a load test.",
      "Requires a rollback path.",
    ],
  },
  {
    id: "gate-timeout",
    question:
      "A gate times out after collecting too few samples. The error rate looks clean. What do you do?",
    difficulty: 3,
    hints: [
      "A clean rate without confidence is not a pass.",
      "The gate can extend, widen, or use load.",
      "Failing closed is a design choice.",
    ],
    answer:
      "I would not promote on a clean point estimate with too few samples. I would check whether the window was shorter than the metric aggregation interval, whether the share was too small for the traffic rate, and whether the service has a traffic cycle that the window missed. Then I would extend the window, raise the share within the exposure budget, or run controlled load at the target scale. If none of those is possible, the gate should fail closed and a human should decide with the uncertainty stated explicitly.",
    followUps: [
      "How do you compute the minimum sample?",
      "What is the risk of raising the share to get samples?",
      "How would you record an override?",
    ],
    redFlags: [
      "Promotes because the error rate is zero.",
      "Raises the share without considering exposure.",
      "Does not record the uncertainty.",
    ],
    rubric: [
      "Refuses to promote on insufficient evidence.",
      "Diagnoses window, share, and aggregation.",
      "Chooses a safe way to get samples.",
      "Records the decision and uncertainty.",
    ],
  },
  {
    id: "rollback",
    question:
      "The final step is at 100% and errors are rising. Walk through the first ten minutes.",
    difficulty: 3,
    hints: [
      "Stop the exposure first.",
      "Check whether rollback is safe for data and schema.",
      "Preserve evidence for the review.",
    ],
    answer:
      "I would stop the rollout and shift traffic back to the stable version if the artifact and schema still support it, or scale the stable fleet up first if capacity was reduced. I would confirm the impact from per-version errors, latency, and dependency saturation, and communicate the rollback and current user impact. If the new version wrote data or called external systems, I would check compatibility and side effects before declaring recovery. Then I would preserve the deployment timeline, gate decisions, and metrics, fix the cause, and re-enter at a small share with a gate that covers the missed signal.",
    followUps: [
      "What would make rollback unsafe?",
      "How do you verify recovery after the shift back?",
      "What change to the sequence would prevent a repeat?",
    ],
    redFlags: [
      "Keeps the final step while errors rise.",
      "Rolls back without checking data compatibility.",
      "Skips the review of the gate design.",
    ],
    rubric: [
      "Stops exposure and restores stable traffic.",
      "Checks data and schema compatibility.",
      "Communicates impact and preserves evidence.",
      "Fixes the gate or sequence before retrying.",
    ],
  },
];

const checklist = [
  {
    title: "Before the sequence",
    items: [
      "Write the exposure budget: how many users may see a bad build before the gate acts.",
      "Choose step sizes that fit the budget and keep a stable control until the final step.",
      "Calculate the sample each gate needs from traffic rate, share, and window.",
      "Define per-version error, latency, saturation, and capacity gates with stop conditions.",
      "Confirm the previous artifact and schema support rollback from the final step.",
    ],
  },
  {
    title: "During the sequence",
    items: [
      "Compare the new version with stable traffic at the same timestamps.",
      "Stop on a critical gate; do not advance because the step is small or the hour is late.",
      "Fail closed when the gate has too few samples to decide.",
      "Watch shared dependencies, not only the new version's own CPU.",
      "Record every promotion, override, and gate timeout.",
    ],
  },
  {
    title: "After the sequence",
    items: [
      "Verify the full fleet at peak traffic, including dependencies and quotas.",
      "Review whether the gate samples were representative of the traffic mix.",
      "Compare the actual exposure with the budget and explain any gap.",
      "Add the missed signal or step constraint before the next release.",
    ],
  },
];

const references = [
  {
    title: "Canarying Releases",
    url: "https://sre.google/workbook/canarying-releases/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Canary population, duration, metric selection, and the limits of a small traffic slice.",
  },
  {
    title: "Deployment configurations",
    url: "https://docs.aws.amazon.com/codedeploy/latest/userguide/deployment-configurations.html",
    publisher: "AWS CodeDeploy",
    kind: "docs" as const,
    note: "Canary and linear traffic-shifting configurations with bake time between steps.",
  },
  {
    title: "Automating safe, hands-off deployments",
    url: "https://aws.amazon.com/builders-library/automating-safe-hands-off-deployments/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Staged rollout, one-box alarms, bake time, and metric data-point requirements.",
  },
];

export const trafficShiftingModel = model;

export const module: Module = {
  meta,
  primer,
  sims: {
    "traffic-shifting": {
      model,
      presets,
      instructions:
        "Start with Healthy, then apply One big step and watch errors rise while the gate still has samples. Apply Short gate to see a sample-size failure, then Recovery to see a fixed build moved in a small step. Run the experiment before applying its fix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Request rates, defect rates, sample minimum, and thresholds are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "deployment-canary",
    "deployment-canary-capacity",
    "deployment-automated-rollback",
    "deployment-rolling",
  ],
};
