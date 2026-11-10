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

const BASE_WORK = 48;
const BUILD_SHARE = 20;
const TEST_SHARE = 28;

const params: ParamSpec[] = [
  {
    id: "parallelism",
    label: "Parallel runner slots",
    min: 1,
    max: 16,
    step: 1,
    value: 4,
    unit: " slots",
    group: "Compute",
    help: "Parallel jobs the build and test stages can use. More slots divide work but only up to the number of independent shards.",
    format: "number",
  },
  {
    id: "cacheHit",
    label: "Dependency cache hit rate",
    min: 0,
    max: 100,
    step: 5,
    value: 60,
    unit: "%",
    group: "Cache",
    help: "Share of dependency downloads and build inputs served from cache. Cache misses repeat work that a previous run already did.",
    format: "percent",
  },
  {
    id: "flakyRate",
    label: "Flaky test rate",
    min: 0,
    max: 20,
    step: 1,
    value: 1,
    unit: "%",
    group: "Reliability",
    help: "Share of test runs that fail for reasons unrelated to the change and must be retried. Retries add lead time and teach teams to ignore red builds.",
    format: "percent",
  },
  {
    id: "gateMinutes",
    label: "Approval gate wait",
    min: 0,
    max: 60,
    step: 5,
    value: 5,
    unit: " min",
    group: "Gate",
    help: "Time a change waits for a manual approval. A gate can be fast and still add value if it checks a real risk.",
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
  slots: number;
  cache: number;
  flaky: number;
  gate: number;
  build: number;
  test: number;
  retry: number;
  feedback: number;
  lead: number;
  bypass: number;
  approvalShare: number;
}

function compute(p: Params): Values {
  const slots = Math.max(1, num(p, "parallelism", 4));
  const cache = clamp(num(p, "cacheHit", 60), 0, 100);
  const flaky = clamp(num(p, "flakyRate", 1), 0, 100);
  const gate = Math.max(0, num(p, "gateMinutes", 5));
  const cacheFactor = 1 - 0.5 * (cache / 100);
  const build = (BUILD_SHARE / slots) * cacheFactor;
  const test = (TEST_SHARE / slots) * cacheFactor;
  const retry = (flaky / 100) * BASE_WORK * 0.4;
  const feedback = (BASE_WORK * 0.4 / slots) * cacheFactor + 1;
  const lead = build + test + retry + gate;
  const bypass = clamp((lead - 30) * 2, 0, 100);
  const approvalShare = lead > 0 ? (gate / lead) * 100 : 0;
  return { slots, cache, flaky, gate, build, test, retry, feedback, lead, bypass, approvalShare };
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

function mins(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)} min`;
}

function buildFrame(p: Params, seed: number, v: Values): SimFrame {
  const leadHealth = level(v.lead, 30, 60);
  const bypassHealth = level(v.bypass, 25, 50);
  const feedbackHealth = level(v.feedback, 10, 20);
  const gateHealth = level(v.approvalShare, 60, 80);
  const overall = worst(leadHealth, bypassHealth, feedbackHealth, gateHealth);

  const nodes = [
    {
      id: "commit",
      label: "Commit",
      kind: "client" as const,
      health: "ok" as const,
      sublabel: "Change enters the pipeline",
      detail: "The pipeline starts when a change is pushed. From this moment, the author is waiting for a signal.",
      meta: { view: "flow" },
    },
    {
      id: "build",
      label: "Build",
      kind: "service" as const,
      health: feedbackHealth,
      utilization: clamp(v.build / 20),
      sublabel: `${mins(v.build)} · ${v.slots} slots · cache ${v.cache.toFixed(0)}%`,
      detail: `The build stage takes ${mins(v.build)} with ${v.slots} parallel slots and a ${v.cache.toFixed(0)}% cache hit rate. Cache misses repeat work from previous runs.`,
      meta: { view: "flow" },
    },
    {
      id: "test",
      label: "Test",
      kind: "service" as const,
      health: feedbackHealth,
      utilization: clamp(v.test / 28),
      sublabel: `${mins(v.test)} · flaky ${v.flaky.toFixed(0)}% · retry ${mins(v.retry)}`,
      detail: `The test stage takes ${mins(v.test)}. At a ${v.flaky.toFixed(0)}% flaky rate, retries add about ${mins(v.retry)} to the pipeline and weaken trust in a red result.`,
      meta: { view: "flow" },
    },
    {
      id: "gate",
      label: "Approval gate",
      kind: "service" as const,
      health: gateHealth,
      utilization: clamp(v.gate / 60),
      sublabel: `${mins(v.gate)} wait · ${v.approvalShare.toFixed(0)}% of lead time`,
      detail: `The approval gate waits ${mins(v.gate)} and accounts for ${v.approvalShare.toFixed(0)}% of the end-to-end lead time. A gate that costs more than the work it protects becomes the constraint.`,
      meta: { view: "flow" },
    },
    {
      id: "deploy",
      label: "Deploy",
      kind: "service" as const,
      health: overall,
      sublabel: `lead ${mins(v.lead)} · bypass risk ${v.bypass.toFixed(0)}%`,
      detail: "Teams route around a pipeline when waiting costs more than the risk it removes. The bypass risk is the adoption signal, not a moral judgment about the team.",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("commit-build", "commit", "build", 1, feedbackHealth),
      edge("build-test", "build", "test", 1, feedbackHealth),
      edge("test-gate", "test", "gate", 1, gateHealth),
      edge("gate-deploy", "gate", "deploy", clamp(1 - v.bypass / 100), overall),
    ],
    metrics: [
      metric("lead-time", "Pipeline lead time", v.lead, " min", 30, 60, "number"),
      metric("bypass-rate", "Estimated pipeline bypass", v.bypass, "%", 25, 50, "percent"),
      metric("feedback-time", "Time to first signal", v.feedback, " min", 10, 20, "number"),
      metric("approval-share", "Approval share of lead time", v.approvalShare, "%", 60, 80, "percent"),
      metric("retry-time", "Flaky retry time", v.retry, " min", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      lead: v.lead,
      feedback: v.feedback,
      bypass: v.bypass,
      approvalShare: v.approvalShare,
    },
    summary: `Lead ${mins(v.lead)} · first signal ${mins(v.feedback)} · gate ${mins(v.gate)} · bypass risk ${v.bypass.toFixed(0)}%`,
  };
}

function seedSeries(frame: SimFrame, v: Values, seed: number): void {
  const jitter = (index: number) => 1 + 0.01 * Math.sin((index + (seed % 6)) / 2.2);
  const series: [string, number][] = [
    ["lead-time", v.lead],
    ["bypass-rate", v.bypass],
    ["feedback-time", v.feedback],
    ["approval-share", v.approvalShare],
    ["retry-time", v.retry],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "lead-time",
    metricId: "lead-time",
    warn: 30,
    crit: 60,
    title: "The pipeline is slower than the work it protects",
    cause:
      "A long pipeline turns every small change into a long wait. Teams batch work, context-switch, and eventually deploy around the pipeline, so the control stops covering the changes that matter.",
    fix:
      "Find the stage that dominates lead time, then parallelize, cache, remove redundant work, or shorten the approval. Measure the effect on lead time and on escaped defects, not just on stage duration.",
    checkFirst: [
      "Compare build, test, retry, gate, and queue time by stage.",
      "Check whether the pipeline is slow for every change or only for large ones.",
      "Check whether slow runs are concentrated on one runner pool or test shard.",
    ],
  },
  {
    id: "bypass-rate",
    metricId: "bypass-rate",
    warn: 25,
    crit: 50,
    title: "Teams are deploying around the pipeline",
    cause:
      "When waiting costs more than the perceived risk, engineers use a laptop, a manual deploy, or a console change. The bypass is a rational response to a pipeline that does not fit the work.",
    fix:
      "Reduce lead time and make the safe path the fastest path. Then measure bypasses and treat them as adoption signals, not only as policy violations.",
    checkFirst: [
      "Compare pipeline lead time with the time a bypass takes.",
      "Check which teams or change types bypass most often.",
      "Check whether bypassed changes have a different incident rate.",
    ],
  },
  {
    id: "feedback-time",
    metricId: "feedback-time",
    warn: 10,
    crit: 20,
    title: "The first signal arrives too late",
    cause:
      "The time to the first useful test result, not the total pipeline, decides whether an author can stay in flow. Slow feedback encourages batching and local-only verification.",
    fix:
      "Run fast checks first, parallelize the slow suite, and cache dependencies. Report a useful signal early even if the full suite runs later.",
    checkFirst: [
      "Check the time to the first failing or passing test.",
      "Check whether fast checks wait behind slow setup.",
      "Check whether the test suite is ordered by duration or by value.",
    ],
  },
  {
    id: "approval-share",
    metricId: "approval-share",
    warn: 60,
    crit: 80,
    title: "The approval gate dominates lead time",
    cause:
      "The work is fast but the change waits for a human. The gate may still be useful, but if it takes longer than build and test combined, it is the constraint and the reason teams bypass.",
    fix:
      "Decide what the gate actually checks. Automate checks that can be automated, set an approval service level, and reserve manual review for changes where judgment adds value.",
    checkFirst: [
      "Compare gate wait with active work time.",
      "Check whether approvals arrive in a batch at a fixed time.",
      "Check whether low-risk changes need the same gate as high-risk changes.",
    ],
  },
];

const model: SimModel = {
  id: "deployment-cicd",
  visual: "flow",
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
    const drift = 1 + rng.between(-0.001, 0.001) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "retry-time" ? { ...item, value: Math.max(0, item.value * drift) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items = [
      `Build is ${mins(v.build)} and test is ${mins(v.test)} with ${v.slots} slots and a ${v.cache.toFixed(0)}% cache hit rate. Together they are ${mins(v.build + v.test)} of active work.`,
      `Flaky retries add about ${mins(v.retry)}, and the approval gate adds ${mins(v.gate)}. Lead time is ${mins(v.lead)}.`,
      `The first useful signal arrives at ${mins(v.feedback)}. That is the number an author feels while deciding whether to stay in flow.`,
      `The approval gate is ${v.approvalShare.toFixed(0)}% of lead time. ${v.approvalShare >= 60 ? "It is the constraint, not the build." : "Active work is still a meaningful share of the wait."}`,
    ];
    if (v.bypass >= 50) {
      items.push(`At a ${v.bypass.toFixed(0)}% estimated bypass rate, the pipeline is no longer the control for a large share of changes. Shorten the path before adding more checks.`);
    } else {
      items.push(`The estimated bypass rate is ${v.bypass.toFixed(0)}%. Keep the safe path faster than the workaround.`);
    }
    items.push("Parallelism and caching reduce work time; flaky retries and approval waits add time without adding evidence. Optimize the constraint, not every stage.");
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
    description: "Four slots, 60% cache hits, 1% flaky tests, and a five-minute gate.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Two slots, 30% cache hits, 5% flaky tests, and a 20-minute gate.",
    tone: "warn",
    params: defaults({ parallelism: 2, cacheHit: 30, flakyRate: 5, gateMinutes: 20 }),
  },
  {
    id: "failure",
    label: "Slow serial pipeline",
    description: "One slot, no cache, 12% flaky tests, and a 30-minute gate.",
    tone: "crit",
    params: defaults({ parallelism: 1, cacheHit: 0, flakyRate: 12, gateMinutes: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Eight slots, 80% cache hits, 1% flaky tests, and a five-minute gate.",
    tone: "ok",
    params: defaults({ parallelism: 8, cacheHit: 80, flakyRate: 1, gateMinutes: 5 }),
  },
  {
    id: "manual-gate",
    label: "Approval gate",
    description: "A fast eight-slot build behind a 60-minute manual approval.",
    tone: "crit",
    params: defaults({ parallelism: 8, cacheHit: 80, flakyRate: 2, gateMinutes: 60 }),
  },
];

const experiment: Experiment = {
  id: "predict-bypass",
  title: "Predict what makes teams bypass the pipeline",
  simId: "cicd",
  question:
    "The pipeline takes 80 minutes and teams deploy from laptops. Which change reduces bypass the most?",
  prediction: {
    options: [
      { id: "speed", label: "Cut feedback and lead time with parallelism, cache, and a shorter gate" },
      { id: "approval", label: "Add a second approval step to make the pipeline more credible" },
      { id: "tests", label: "Add another slow end-to-end suite" },
      { id: "batch", label: "Ask teams to batch more changes per pipeline run" },
    ],
    correctOptionId: "speed",
    explanation:
      "Bypass is an adoption problem. Teams route around a pipeline when waiting costs more than the risk it removes. Adding approvals or tests increases the wait; reducing feedback and lead time makes the safe path the fastest path.",
  },
  setup: defaults({ parallelism: 1, cacheHit: 0, flakyRate: 12, gateMinutes: 30 }),
  runFor: 20,
  observe: [
    "Lead time reaches about 80 minutes and the first signal takes about 20.",
    "The estimated bypass rate reaches 100%.",
    "Flaky retries add almost three minutes and weaken trust in red builds.",
    "The approval gate is only 37% of the wait; most of the time is serial work.",
  ],
  explain:
    "Pipeline speed is not a comfort feature. It determines whether the pipeline is used. The constraint is the stage that dominates feedback and lead time, which here is serial build and test work, not the gate. Parallelism and caching attack that constraint without removing safety.",
  fix: defaults({ parallelism: 8, cacheHit: 80, flakyRate: 1, gateMinutes: 5 }),
  debrief:
    "The fixed pipeline runs in about nine minutes with a two-minute first signal and effectively no bypass. The tradeoff is cost: eight runner slots and a cache are not free, and a cache can serve stale dependencies if invalidation is wrong. Those are deliberate engineering costs, paid to make the safe path the default.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A CI/CD pipeline builds a change, tests it, gates it, and deploys it. Continuous integration (CI) produces a verified artifact; continuous delivery or deployment (CD) moves that artifact toward production. The pipeline is also a product with users: the engineers who wait for it. If it is slow or unreliable, they will batch changes, test locally, or deploy around it.",
  },
  {
    type: "p",
    text: "Lead time is the end-to-end wait from commit to deployed change. It includes active work, queueing for runners, retries after flaky failures, and any manual approval. Feedback time is the wait to the first useful signal. Both matter: feedback decides whether an author can stay in flow, and lead time decides whether the pipeline is faster than the workaround.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The pipeline sits between the commit and the deployment controller. It should produce one immutable artifact and promote it, not rebuild for each environment. The pipeline is also where safety checks live: tests, security scans, artifact signing, and policy checks. The design question is not whether to have checks but which checks need to block a change and when their signal is worth the wait.",
  },
  {
    type: "table",
    headers: ["Component", "What it adds", "How to reduce it"],
    rows: [
      ["Build work", "Compilation, packaging, image layers", "Parallelism, cache, smaller inputs"],
      ["Test work", "Unit, integration, end-to-end suites", "Sharding, ordering, removing duplicate coverage"],
      ["Flaky retries", "Re-runs that add no new evidence", "Fix isolation, quarantine, report flakiness"],
      ["Approval gate", "Human judgment and wait", "Automate checks, set a service level, scope the gate"],
      ["Queueing", "Waiting for runners or reviewers", "Capacity, scheduling, smaller batches"],
    ],
  },
  {
    type: "p",
    text: "The values in this module are illustrative teaching values. The 48-minute base work, 20/28 split, retry penalty, bypass curve, and thresholds are teaching choices, not DORA (DevOps Research and Assessment) benchmarks. The shape is the lesson: active work responds to parallelism and caching, flakiness adds retries, and an approval gate adds wait that can dominate everything else.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Pipeline lead time: build, test, retry, and gate time end to end.",
      "Time to first signal: how long an author waits for a useful result.",
      "Estimated bypass: the adoption signal when the pipeline is slower than the workaround.",
      "Approval share: how much of lead time is waiting for a human.",
      "A flow from commit through build, test, and approval to deploy.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Slow serial pipeline. Watch lead time and bypass risk rise together. Apply Approval gate to see a fast pipeline whose wait is dominated by one manual step, then Recovery. Run the experiment before applying its fix.",
  },
  {
    type: "p",
    text: "A pipeline design should name its constraint. If build dominates, parallelize or cache. If tests dominate, shard or remove duplicate coverage. If the gate dominates, automate what can be automated and set a response time for what cannot. If flakiness dominates, fix isolation before adding capacity. Optimizing the wrong stage spends money and leaves the wait unchanged.",
  },
  { type: "sim", simId: "cicd" },
  { type: "experiment", experimentId: "predict-bypass" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In Slow serial pipeline, one runner slot, no cache, and a 12% flaky rate produced about 80 minutes of lead time and a 20-minute first signal. The estimated bypass rate reached 100%: not because the teams were careless, but because the pipeline was slower than deploying from a laptop. In Approval gate, the build was fast but a 60-minute approval dominated lead time and pushed bypass risk to 68%.",
  },
  {
    type: "p",
    text: "Recovery uses eight slots, an 80% cache, 1% flaky tests, and a five-minute gate. Lead time falls to about nine minutes and the first signal arrives in about two. The pipeline becomes the fastest path, so adoption improves without adding a policy.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Lead time by stage, including queue time before a runner picks up the job.",
      "Time to first failure or first passing check, not only total run time.",
      "Flaky test rate, retry count, and the share of red builds that turn green on retry.",
      "Approval wait time and the share of changes that wait for a human.",
      "Deployments that bypass the pipeline, with the change type and reason.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the stage that dominates lead time before changing anything. Check whether the first signal is fast enough for an author to stay in flow. Then compare the safe path with the workaround: if the pipeline is slower, bypass is the predictable result.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure lead time and feedback time by stage, including queueing and retries.",
      "Attack the dominant constraint: parallelism, cache, test selection, or gate design.",
      "Fix or quarantine flaky tests so red builds mean something.",
      "Automate checks that do not need human judgment and set a service level for the ones that do.",
      "Keep the artifact immutable and promote it rather than rebuilding per environment.",
      "Track bypass and escaped defects to confirm the pipeline is both used and effective.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More parallel runners cut lead time but cost money and can overwhelm shared test dependencies.",
      "Caching speeds up builds but can serve stale or poisoned dependencies if invalidation is weak.",
      "Removing a slow test shortens feedback but may remove the only check for a real failure mode.",
      "A shorter gate speeds delivery but needs a clear risk scope and an approver with authority.",
      "Smaller batches reduce risk but increase pipeline runs and total compute.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "slow-pipeline",
    question:
      "The pipeline takes 90 minutes and teams are deploying around it. How do you fix it?",
    difficulty: 2,
    hints: [
      "Measure the stages before changing them.",
      "Adoption follows the safe path versus the workaround.",
      "Do not remove checks without measuring what they catch.",
    ],
    answer:
      "I would measure lead time and feedback time by stage, including runner queueing, test duration, retries, and approval wait. Then I would attack the dominant constraint: parallelize or cache the slow work, shard tests, fix or quarantine flaky tests, and shorten the approval gate or automate what it checks. I would compare the pipeline time with the workaround and track bypass as an adoption signal. I would not remove a check until I knew what it caught and had another control for that risk.",
    followUps: [
      "Which metric tells you whether an author can stay in flow?",
      "How would you know a test is safe to remove?",
      "What would you do if the approval gate is the constraint?",
    ],
    redFlags: [
      "Adds approvals to enforce use.",
      "Optimizes every stage equally.",
      "Removes tests without measuring coverage of risk.",
    ],
    rubric: [
      "Measures by stage.",
      "Attacks the constraint.",
      "Tracks bypass and feedback.",
      "Preserves necessary checks.",
    ],
  },
  {
    id: "cache",
    question:
      "You add dependency caching and lead time drops, but a production build later uses a stale package. What went wrong, and how do you fix it?",
    difficulty: 3,
    hints: [
      "A cache key is part of correctness.",
      "Immutable artifacts and lockfiles matter.",
      "A cache hit should be reproducible.",
    ],
    answer:
      "The cache key did not capture the dependency identity or the build inputs, so a change that should have missed the cache hit it instead. I would key the cache on the lockfile and relevant build inputs, avoid caching mutable or unpinned dependencies, and verify the artifact digest against the expected source. I would also make the build reproducible from a clean cache in CI so a poisoned or stale entry is caught before release. Speed is only useful if the cached result is the same result.",
    followUps: [
      "What would you include in the cache key?",
      "How do you test that a clean build still works?",
      "Would you cache build outputs or only dependencies?",
    ],
    redFlags: [
      "Caches everything by branch name.",
      "Trusts cache hits without a clean-build check.",
      "Disables caching entirely after one incident.",
    ],
    rubric: [
      "Explains cache-key correctness.",
      "Uses lockfiles and immutable inputs.",
      "Verifies with a clean build.",
      "Keeps the speed benefit.",
    ],
  },
  {
    id: "gate",
    question:
      "A manual approval gate adds 40 minutes to every change. How do you decide whether to keep it?",
    difficulty: 2,
    hints: [
      "Ask what the gate checks.",
      "Measure the risk it catches and the wait it adds.",
      "Automation may cover part of the check.",
    ],
    answer:
      "I would list what the approver actually checks and compare that with the incidents or near misses the gate has caught. If the check is mechanical, such as a policy or a test result, I would automate it. If it needs judgment, I would scope it to high-risk changes and set a response-time target for the rest. I would measure lead time and escaped risk before and after the change, so removing wait does not silently remove a control.",
    followUps: [
      "How would you measure what the gate catches?",
      "Which changes would keep manual review?",
      "What service level would you set for approvers?",
    ],
    redFlags: [
      "Keeps the gate because it has always existed.",
      "Removes it without checking what it caught.",
      "Automates a judgment call with no override.",
    ],
    rubric: [
      "Identifies the gate's purpose.",
      "Uses incident and near-miss evidence.",
      "Automates or scopes the check.",
      "Measures lead time and risk.",
    ],
  },
];

const checklist = [
  {
    title: "Measure",
    items: [
      "Track lead time and time to first signal by stage, including queueing and retries.",
      "Track flaky rate and the share of red builds that pass on retry.",
      "Track pipeline bypass with change type and reason.",
      "Compare pipeline time with the workaround teams actually use.",
      "Measure escaped defects alongside speed so a faster pipeline is not a weaker one.",
    ],
  },
  {
    title: "Optimize",
    items: [
      "Attack the stage that dominates lead time, not every stage at once.",
      "Parallelize independent work and cache immutable inputs with correct keys.",
      "Fix test isolation or quarantine flaky tests instead of normalizing retries.",
      "Automate mechanical checks and scope manual gates to changes that need judgment.",
      "Build once and promote the same artifact through environments.",
    ],
  },
  {
    title: "Operate",
    items: [
      "Alert on pipeline duration and queue time, not only on failures.",
      "Review bypasses as adoption signals and fix the wait that caused them.",
      "Recheck cache correctness with periodic clean builds.",
      "Revisit the constraint after each change; it moves.",
    ],
  },
];

const references = [
  {
    title: "DORA metrics: the four keys",
    url: "https://dora.dev/guides/dora-metrics-four-keys/",
    publisher: "DORA",
    kind: "docs" as const,
    note: "DORA (DevOps Research and Assessment) lead time, deployment frequency, change failure rate, and recovery time.",
  },
  {
    title: "Caching dependencies to speed up workflows",
    url: "https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows",
    publisher: "GitHub",
    kind: "docs" as const,
    note: "Cache keys, restore keys, and the correctness limits of dependency caching.",
  },
];

export const cicdModel = model;

export const module: Module = {
  meta,
  primer,
  sims: {
    cicd: {
      model,
      presets,
      instructions:
        "Start with Healthy, then apply Slow serial pipeline and compare lead time with bypass risk. Apply Approval gate to see the wait move to the gate, then Recovery. Run the experiment before applying its fix.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Base work, stage split, retry penalty, bypass curve, and thresholds are teaching values, not DORA benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "deployment-frequency",
    "deployment-lead-time",
    "deployment-rolling",
    "deployment-build-once",
  ],
};
