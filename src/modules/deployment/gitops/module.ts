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
    id: "reconcileMinutes",
    label: "Reconciliation interval",
    min: 1,
    max: 30,
    step: 1,
    value: 2,
    unit: " min",
    group: "Reconciliation",
    help: "How often the controller compares the cluster with Git and reverts differences. Shorter intervals keep production closer to Git but leave less room for a manual fix.",
    format: "number",
  },
  {
    id: "reviewMinutes",
    label: "Expedited Git review",
    min: 5,
    max: 60,
    step: 5,
    value: 8,
    unit: " min",
    group: "Change path",
    help: "Time to review and merge an urgent change through Git during an incident. This is the safe path, not the console workaround.",
    format: "number",
  },
  {
    id: "driftPerHour",
    label: "Manual changes per hour",
    min: 0,
    max: 12,
    step: 0.5,
    value: 1,
    unit: " changes/h",
    group: "Drift",
    help: "Out-of-band console or kubectl changes made per hour. A rate, not a queue depth. Reconciliation reverts them when automatic sync is on.",
    format: "number",
  },
  {
    id: "autoSync",
    label: "Automatic reconciliation (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Reconciliation",
    help: "One means the controller applies Git and reverts drift automatically. Zero means it reports drift but leaves the cluster unchanged until a human syncs.",
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

interface Values {
  reconcile: number;
  review: number;
  drift: number;
  autoSync: boolean;
  timeToSafeFix: number;
  driftWindow: number;
  reverts: number;
  unmanaged: number;
}

function compute(p: Params): Values {
  const reconcile = Math.max(1, num(p, "reconcileMinutes", 2));
  const review = Math.max(1, num(p, "reviewMinutes", 8));
  const drift = Math.max(0, num(p, "driftPerHour", 1));
  const autoSync = num(p, "autoSync", 1) >= 0.5;
  const timeToSafeFix = review + reconcile + 2;
  const driftWindow = autoSync ? reconcile : 60;
  const reverts = autoSync ? drift : 0;
  const unmanaged = autoSync ? 0 : drift;
  return { reconcile, review, drift, autoSync, timeToSafeFix, driftWindow, reverts, unmanaged };
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

function buildFrame(p: Params, seed: number, v: Values): SimFrame {
  const fixHealth = level(v.timeToSafeFix, 20, 40);
  const driftHealth = level(v.driftWindow, 5, 15);
  const revertHealth = level(v.reverts, 4, 8);
  const unmanagedHealth = level(v.unmanaged, 2, 5);
  const overall = worst(fixHealth, driftHealth, revertHealth, unmanagedHealth);

  const nodes = [
    {
      id: "git",
      label: "Git desired state",
      kind: "storage" as const,
      health: "ok" as const,
      sublabel: "Reviewed commit is the source of truth",
      detail: "The manifest, Helm values, or Kustomize overlay in Git is the desired state. A change that is not committed is not part of the system of record.",
      meta: { view: "flow" },
    },
    {
      id: "reconciler",
      label: "Reconciler",
      kind: "service" as const,
      health: driftHealth,
      utilization: clamp(v.reconcile / 30),
      sublabel: `sync every ${v.reconcile} min · ${v.autoSync ? "auto-apply" : "detect only"}`,
      detail: `The controller compares live state with Git every ${v.reconcile} minutes. With auto-sync ${v.autoSync ? "on" : "off"}, drift is ${v.autoSync ? "reverted automatically" : "reported but left in place"}.`,
      meta: { view: "flow" },
    },
    {
      id: "cluster",
      label: "Cluster",
      kind: "service" as const,
      health: worst(driftHealth, unmanagedHealth, revertHealth),
      sublabel: `${v.autoSync ? `${v.reverts.toFixed(1)} reverted/h` : `${v.unmanaged.toFixed(1)} unmanaged/h`} · ${v.driftWindow.toFixed(0)} min drift window`,
      detail: `Production can differ from Git for up to ${v.driftWindow.toFixed(0)} minutes in this model. Automatic sync makes the window short and also destroys an uncommitted hotfix at the next pass.`,
      meta: { view: "flow" },
    },
    {
      id: "console",
      label: "Console edit",
      kind: "external" as const,
      health: worst(revertHealth, unmanagedHealth),
      sublabel: v.autoSync ? "Survives until the next reconcile" : "Persists but is not in Git",
      detail: "A console or kubectl edit is drift by definition. It may fix the symptom, but it is invisible to review and will be reconciled away or persist as unmanaged state.",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("git-reconciler", "git", "reconciler", 1, driftHealth),
      edge("reconciler-cluster", "reconciler", "cluster", v.autoSync ? 1 : 0.4, overall),
      edge("console-cluster", "console", "cluster", clamp(v.drift / 12), worst(revertHealth, unmanagedHealth)),
    ],
    metrics: [
      metric("time-to-safe-fix", "Time to safe fix through Git", v.timeToSafeFix, " min", 20, 40, "number"),
      metric("drift-window", "Production drift window", v.driftWindow, " min", 5, 15, "number"),
      metric("reverted-changes", "Manual changes reverted", v.reverts, " changes/h", 4, 8, "number"),
      metric("unmanaged-drift", "Unmanaged drift", v.unmanaged, " changes/h", 2, 5, "number"),
      metric("reconcile-interval", "Reconciliation interval", v.reconcile, " min", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      autoSync: v.autoSync ? 1 : 0,
      driftWindow: v.driftWindow,
      reverts: v.reverts,
      unmanaged: v.unmanaged,
      timeToSafeFix: v.timeToSafeFix,
    },
    summary: `${v.autoSync ? "Auto-sync on" : "Auto-sync off"} · safe fix ${v.timeToSafeFix.toFixed(0)} min · ${v.driftWindow.toFixed(0)} min drift window · ${v.reverts.toFixed(1)} reverted/h`,
  };
}

function seedSeries(frame: SimFrame, v: Values, seed: number): void {
  const jitter = (index: number) => 1 + 0.01 * Math.sin((index + (seed % 10)) / 2.3);
  const series: [string, number][] = [
    ["time-to-safe-fix", v.timeToSafeFix],
    ["drift-window", v.driftWindow],
    ["reverted-changes", v.reverts],
    ["unmanaged-drift", v.unmanaged],
    ["reconcile-interval", v.reconcile],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "time-to-safe-fix",
    metricId: "time-to-safe-fix",
    warn: 20,
    crit: 40,
    title: "The safe Git path is too slow for an incident",
    cause:
      "Review plus reconciliation delay makes the reviewed path slower than a console edit. During an incident, that gap is exactly when an engineer is most likely to bypass Git and create drift.",
    fix:
      "Create an expedited review path for incident changes, keep the commit small, and shorten the apply latency. The exception still goes through Git, but with a named approver and a deadline.",
    checkFirst: [
      "Measure review time and apply latency separately.",
      "Check whether the emergency path is documented and reachable.",
      "Check whether the last incident fix went through Git or the console.",
    ],
  },
  {
    id: "drift-window",
    metricId: "drift-window",
    warn: 5,
    crit: 15,
    title: "Production can drift from Git for too long",
    cause:
      "A long reconciliation interval or disabled automatic sync lets production differ from the reviewed desired state. The cluster may look healthy while the system of record no longer describes it.",
    fix:
      "Shorten the interval or enable automatic reconciliation, and alert on drift age rather than only on sync failure. If sync must be paused, set a bounded window and an owner who resumes it.",
    checkFirst: [
      "Check the age of the oldest unsynced difference.",
      "Check whether auto-sync is disabled and who disabled it.",
      "Check whether a manual change is the only reason for the drift.",
    ],
  },
  {
    id: "reverted-changes",
    metricId: "reverted-changes",
    warn: 4,
    crit: 8,
    title: "Reconciliation is reverting manual changes",
    cause:
      "Automatic sync treats every difference from Git as drift. During an incident, a console hotfix is a difference, so the next reconcile pass removes it, often before the incident is resolved.",
    fix:
      "Commit the fix through the expedited path, or pause auto-sync for a bounded window with a named owner and a resume deadline. Do not rely on a console change surviving reconciliation.",
    checkFirst: [
      "Compare the revert timestamp with the incident timeline.",
      "Check whether the fix exists in Git.",
      "Check who enabled auto-sync and whether a pause was agreed.",
    ],
  },
  {
    id: "unmanaged-drift",
    metricId: "unmanaged-drift",
    warn: 2,
    crit: 5,
    title: "Drift is persisting outside Git",
    cause:
      "With automatic reconciliation off, manual changes survive but are not reviewed or reproducible. The cluster becomes the source of truth, and the next rebuild or failover loses the change.",
    fix:
      "Re-enable reconciliation after the emergency, commit the change, and diff the cluster against Git. A pause is a temporary exception, not an operating mode.",
    checkFirst: [
      "Diff live state against Git for the changed resources.",
      "Check how long auto-sync has been off.",
      "Check whether the next rebuild or failover would reproduce the change.",
    ],
  },
];

const model: SimModel = {
  id: "deployment-gitops",
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
    const drift = 1 + rng.between(-0.002, 0.002) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "reconcile-interval" ? { ...item, value: Math.max(0, item.value * drift) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items = [
      `Git is the desired state. The controller compares it with the cluster every ${v.reconcile} minutes; with auto-sync ${v.autoSync ? "on, it applies Git and reverts differences" : "off, it reports differences but leaves them in place"}.`,
      `The safe fix path is review ${v.review} min plus reconcile ${v.reconcile} min plus 2 min to apply and verify, or ${v.timeToSafeFix.toFixed(0)} minutes end to end.`,
      v.autoSync
        ? `At ${v.drift.toFixed(1)} manual changes per hour, reconciliation is expected to revert ${v.reverts.toFixed(1)} changes per hour. A console hotfix during an incident is one of them.`
        : `With auto-sync off, ${v.unmanaged.toFixed(1)} manual changes per hour persist outside Git. They survive until a rebuild, failover, or the next human sync.`,
    ];
    if (v.autoSync && v.driftWindow >= 15) {
      items.push("A long interval makes auto-sync slow enough to feel optional. Teams learn to edit the console because the revert is not immediate, then lose the change later.");
    }
    items.push("The safety and the trap are the same property: reconciliation makes Git true. The fix is to shorten the emergency path to Git or bound the pause, not to fight the reconciler.");
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
    description: "Two-minute reconciliation, an eight-minute expedited review, and 1 manual change/hour.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Five-minute reconciliation, a 20-minute review, and 4 manual changes/hour.",
    tone: "warn",
    params: defaults({ reconcileMinutes: 5, reviewMinutes: 20, driftPerHour: 4 }),
  },
  {
    id: "failure",
    label: "Hotfix in console",
    description: "A 15-minute sync, a 45-minute Git review, and 10 manual changes/hour.",
    tone: "crit",
    params: defaults({ reconcileMinutes: 15, reviewMinutes: 45, driftPerHour: 10 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A two-minute sync, an eight-minute expedited review, and almost no manual drift.",
    tone: "ok",
    params: defaults({ reconcileMinutes: 2, reviewMinutes: 8, driftPerHour: 0.5 }),
  },
  {
    id: "sync-off",
    label: "Reconciliation off",
    description: "Auto-sync is disabled during an incident, so 6 manual changes/hour persist outside Git.",
    tone: "crit",
    params: defaults({ reconcileMinutes: 10, reviewMinutes: 10, driftPerHour: 6, autoSync: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-console-hotfix",
  title: "Predict what happens to a console hotfix",
  simId: "gitops",
  question:
    "Auto-sync is on and reconciles every 15 minutes. During an incident, an engineer fixes the problem with a console edit and commits nothing. What happens?",
  prediction: {
    options: [
      { id: "revert", label: "The next reconcile pass reverts the hotfix" },
      { id: "persist", label: "The hotfix becomes the new desired state automatically" },
      { id: "pause", label: "The controller pauses itself while an incident is open" },
      { id: "git", label: "The console edit is written back to Git for review" },
    ],
    correctOptionId: "revert",
    explanation:
      "The controller compares the cluster with Git and applies Git. A console edit is drift, so the next sync removes it. The change was never in the desired state, and reconciliation is doing exactly what it was designed to do.",
  },
  setup: defaults({ reconcileMinutes: 15, reviewMinutes: 45, driftPerHour: 10 }),
  runFor: 20,
  observe: [
    "The safe Git path takes 62 minutes end to end.",
    "Production can differ from Git for 15 minutes.",
    "Ten manual changes per hour are reverted, including the incident hotfix.",
    "The cluster returns to the committed state before the incident is resolved.",
  ],
  explain:
    "GitOps is not a deploy tool; it is a control loop. Git holds the desired state, and the reconciler continuously removes differences. That is what makes rollback and review trustworthy, and it is also why an uncommitted emergency fix has no durability.",
  fix: defaults({ reconcileMinutes: 2, reviewMinutes: 8, driftPerHour: 0.5 }),
  debrief:
    "The fixed setup shortens the safe path to 12 minutes and reduces manual drift, so the incident fix can go through Git and apply quickly. The tradeoff is that a two-minute interval leaves almost no window for a console workaround; the process has to be fast enough that nobody needs one. When it is not, the correct exception is a bounded auto-sync pause with an owner, not a silent edit.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "GitOps is an operating model in which a Git repository holds the desired state of a system and a controller continuously makes the live system match it. The controller reconciles: it compares what Git says with what exists, then applies, creates, or deletes resources to close the gap. Argo CD and Flux are common implementations for Kubernetes; the pattern also appears in infrastructure pipelines.",
  },
  {
    type: "p",
    text: "The same property is the safety and the trap. Reconciliation makes the reviewed commit trustworthy: a manual console change cannot silently persist, and rollback is a revert to a known commit. But during an incident, the fastest fix is often a console edit. Reconciliation does not know that the edit is urgent; it sees drift and removes it. The question is whether the Git path is fast enough to be used under pressure.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "GitOps sits between change review and the cluster. A pull request is the review surface; the controller is the deploy mechanism; the cluster is the observed state. The controller reports sync status and drift, and it can prune resources that are no longer in Git. The pipeline builds artifacts; Git records which artifact and configuration should run.",
  },
  {
    type: "compare",
    leftTitle: "Desired state in Git",
    rightTitle: "Live state in the cluster",
    rows: [
      { label: "Source of truth", left: "Reviewed commit with history", right: "What is actually running now" },
      { label: "Change path", left: "Pull request, review, merge, reconcile", right: "Console edit, kubectl, or an operator" },
      { label: "Rollback", left: "Revert the commit and reconcile", right: "Undo by hand, if the change is known" },
      { label: "Drift", left: "Visible as a diff from Git", right: "Normal until the next reconcile" },
      { label: "Incident speed", left: "Bounded by review and apply latency", right: "Fast, but not durable or reviewed" },
    ],
  },
  {
    type: "p",
    text: "The values in this module are illustrative teaching values. Review time, reconciliation interval, drift rate, and thresholds are teaching choices, not Argo CD or Flux defaults. The model caps the no-auto-sync drift window at 60 minutes. The shape is the lesson: reconciliation period sets the drift window and the hotfix lifetime; review latency sets whether the safe path is usable during an incident.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Time to safe fix: review plus reconcile plus apply, the reviewed path end to end.",
      "Production drift window: how long the cluster can differ from Git.",
      "Manual changes reverted per hour: reconciliation removing out-of-band edits.",
      "Unmanaged drift: edits that persist outside Git when auto-sync is off.",
      "A flow from Git through the reconciler to the cluster, with the console path beside it.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Hotfix in console. Watch the revert rate rise while the safe Git path takes over an hour. Apply Reconciliation off to see the opposite trap: nothing is reverted, but six changes per hour live outside Git. Run the experiment before applying its fix.",
  },
  {
    type: "p",
    text: "An emergency GitOps path needs three things: an expedited review with a named approver, a small commit that can apply quickly, and a way to verify the result. A bounded auto-sync pause is a legitimate exception when the controller itself is in the way, but it needs an owner, a resume deadline, and an audit note. A pause without a deadline becomes unmanaged drift with extra steps.",
  },
  { type: "sim", simId: "gitops" },
  { type: "experiment", experimentId: "predict-console-hotfix" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In Hotfix in console, the safe path through Git took 62 minutes, production could differ from Git for 15 minutes, and reconciliation was expected to revert ten manual changes per hour. The console fix worked until the next sync, then disappeared. The controller was not malfunctioning; it was enforcing the desired state.",
  },
  {
    type: "p",
    text: "Reconciliation off shows the other failure. Nothing is reverted, but six changes per hour persist outside Git, so the cluster becomes the source of truth. A rebuild, failover, or later sync can erase work that nobody recorded. Recovery shortens the Git path to 12 minutes and reduces manual drift, so the reviewed path wins on speed as well as safety.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Sync status, last applied commit, and the age of the oldest drift.",
      "Resources that are out of sync, pruned, or reverted, with timestamps.",
      "Review and merge time for incident changes, including expedited approvals.",
      "Auto-sync pause events, who paused, and when it resumed.",
      "Differences between the live cluster and Git after an incident.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the revert timestamp with the incident timeline to confirm the hotfix was removed by reconciliation. Then check whether the fix exists in Git. If auto-sync is off, check how long it has been off and diff the live state against Git before trusting the cluster.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Re-apply the fix through Git with an expedited review and a named approver.",
      "Verify the reconciled state and the user-facing signal after apply.",
      "If reconciliation must pause, bound the window and assign a resume owner.",
      "Commit any surviving manual change, then re-enable auto-sync and diff.",
      "Shorten review and apply latency so the safe path is faster than the workaround.",
      "Alert on drift age and on long-lived auto-sync pauses, not only on sync failure.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Short reconciliation intervals reduce drift but leave little room for a manual hotfix.",
      "Auto-sync enforces Git but can revert an urgent fix before the incident is resolved.",
      "Auto-sync off preserves manual work but makes the cluster the unreviewed source of truth.",
      "Expedited review shortens the safe path but requires a trusted approver on call.",
      "Pruning removes orphaned resources but can delete something that was added manually for a reason.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "manual-change",
    question:
      "A manual console change disappears after 15 minutes. Explain why and what you would do differently.",
    difficulty: 2,
    hints: [
      "The cluster is being reconciled to a desired state.",
      "Check the last applied commit.",
      "The durable fix has to enter the source of truth.",
    ],
    answer:
      "The reconciler compares the cluster with Git and applies Git, so a console change is drift and is removed at the next sync. I would confirm the revert in the controller's sync history and check the live object against the committed manifest. The durable fix is to commit the change through the normal or expedited review path and let the controller apply it. If the controller itself is blocking recovery, I would pause auto-sync for a bounded window with an owner and a resume deadline, then reconcile and diff.",
    followUps: [
      "How would you prove the change was reverted by the controller?",
      "What is the risk of pausing auto-sync?",
      "How would you handle a resource that is not managed by Git?",
    ],
    redFlags: [
      "Blames the controller for a bug.",
      "Disables auto-sync permanently.",
      "Repeats the console edit without committing it.",
    ],
    rubric: [
      "Explains desired state and reconciliation.",
      "Checks sync history and the commit.",
      "Routes the fix through Git or a bounded pause.",
      "Restores reconciliation.",
    ],
  },
  {
    id: "emergency-path",
    question:
      "Design a GitOps emergency path for a Sev-1 fix that must reach production in ten minutes.",
    difficulty: 3,
    hints: [
      "Keep Git as the source of truth.",
      "One approver with authority beats a long chain.",
      "Verification is part of the path.",
    ],
    answer:
      "I would keep the change in Git but use an expedited path: a small commit against the known-good branch, one named approver with authority, automated checks limited to the critical ones, and immediate reconciliation. I would pre-agree the path and rehearse it, so the approver and the rollback plan are not invented during the incident. If the controller cannot apply within the deadline, I would use a bounded auto-sync pause with a named owner, then commit and reconcile as soon as the fix is confirmed. Verification and a post-incident review are part of the path.",
    followUps: [
      "Which automated checks would you keep?",
      "How do you prevent the emergency path from becoming the default?",
      "What would you do if the Git provider is unavailable?",
    ],
    redFlags: [
      "Bypasses Git with no bound or owner.",
      "Requires the full normal review during a Sev-1.",
      "Has no verification step.",
    ],
    rubric: [
      "Keeps Git as desired state.",
      "Uses one accountable approver.",
      "Bounds any pause and assigns an owner.",
      "Verifies and reviews afterward.",
    ],
  },
  {
    id: "drift",
    question:
      "Auto-sync has been off for three days after an incident. What are the risks, and how do you return to normal?",
    difficulty: 3,
    hints: [
      "The cluster may no longer match Git.",
      "Diff before you re-enable.",
      "The longer the pause, the more changes are unmanaged.",
    ],
    answer:
      "The cluster may contain changes that are not in Git, so re-enabling auto-sync immediately could delete them, and a rebuild could lose them anyway. I would diff every changed resource against Git, identify which changes are still needed, and commit them through review. Then I would re-enable auto-sync in a controlled window, watch the sync and prune events, and verify the affected services. I would also review why the pause lasted three days and add a deadline or alert so the next pause does not become an operating mode.",
    followUps: [
      "How would you find changes that are not in Git?",
      "What would you do with a change that should not be committed?",
      "How do you verify the cluster after re-enabling sync?",
    ],
    redFlags: [
      "Re-enables sync without a diff.",
      "Assumes the cluster matches Git.",
      "Leaves the pause unbounded.",
    ],
    rubric: [
      "Diffs live state against Git.",
      "Commits or consciously discards each change.",
      "Re-enables sync in a controlled window.",
      "Fixes the pause process.",
    ],
  },
  {
    id: "review",
    question:
      "Why is a Git commit a better review surface than a console change, and what does it still not prove?",
    difficulty: 2,
    hints: [
      "History, diff, and reproducibility are part of the answer.",
      "A commit can still be wrong.",
      "Reconciliation proves convergence, not correctness.",
    ],
    answer:
      "A commit gives a reviewable diff, an author, a timestamp, and a reproducible artifact that can be reverted. A console change has none of those properties by default. But a commit does not prove the change is correct, that the rollout is safe, or that the cluster converged as intended. Reconciliation proves convergence to the commit, not that the commit is a good idea. Review and verification still have to cover blast radius and behavior.",
    followUps: [
      "What would you add to the pull request to improve review?",
      "How do you verify convergence after merge?",
      "What can still drift even with GitOps?",
    ],
    redFlags: [
      "Claims Git review prevents all incidents.",
      "Ignores convergence verification.",
      "Treats a commit as a deployment.",
    ],
    rubric: [
      "Names diff, history, and revert.",
      "Separates review from convergence.",
      "Keeps behavior verification.",
      "Acknowledges remaining drift.",
    ],
  },
];

const checklist = [
  {
    title: "Before an incident",
    items: [
      "Document the expedited Git path: approver, checks, apply latency, and verification.",
      "Rehearse the path so the first use is not during a Sev-1.",
      "Set reconciliation intervals and alert on drift age, not only sync failure.",
      "Decide who can pause auto-sync, for how long, and how the pause is recorded.",
      "Keep manifests small enough that an incident change is a focused diff.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Prefer a small commit through the expedited path over a console edit.",
      "If auto-sync must pause, set a deadline and a named resume owner.",
      "Record the console change, the reason, and the verification in the incident timeline.",
      "Check whether the fix is actually in Git before declaring it durable.",
      "Watch for reconciliation reverting the fix while the incident is open.",
    ],
  },
  {
    title: "After an incident",
    items: [
      "Commit or discard every surviving manual change and diff live state against Git.",
      "Re-enable auto-sync and verify convergence and prune behavior.",
      "Review whether the safe path met its deadline.",
      "Shorten the constraint that made the workaround attractive.",
    ],
  },
];

const references = [
  {
    title: "Sync options",
    url: "https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/",
    publisher: "Argo CD",
    kind: "docs" as const,
    note: "Automated sync, pruning, self-healing, and the behavior of drift reconciliation.",
  },
  {
    title: "Flux concepts",
    url: "https://fluxcd.io/flux/concepts/",
    publisher: "Flux",
    kind: "docs" as const,
    note: "Desired state, reconciliation, sources, and the GitOps control loop.",
  },
];

export const gitopsModel = model;

export const module: Module = {
  meta,
  primer,
  sims: {
    gitops: {
      model,
      presets,
      instructions:
        "Start with Healthy, then apply Hotfix in console and compare the safe Git path with the revert rate. Apply Reconciliation off to see unmanaged drift, then Recovery. Run the experiment before applying its fix.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Reconciliation intervals, review times, drift rates, and thresholds are teaching values, not Argo CD or Flux defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "deployment-config-drift",
    "deployment-build-once",
    "deployment-immutable-artifacts",
    "deployment-incident-deploy",
  ],
};
