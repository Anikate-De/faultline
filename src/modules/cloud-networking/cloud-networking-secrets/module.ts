import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111122223333:secret:orders-db-AbCdEf";

const params = [
  {
    id: "refresh",
    label: "Runtime refresh",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Consumer",
    help: "1 means consumers re-read the secret and rebuild their connection pool. 0 means they keep the credential they read at startup until a restart.",
    format: "count" as const,
  },
  {
    id: "grace",
    label: "Old secret grace",
    min: 0,
    max: 300,
    step: 10,
    value: 120,
    unit: " s",
    group: "Rotation",
    help: "How long the previous credential stays valid after rotation. A dual-secret window gives consumers time to refresh.",
    format: "number" as const,
  },
  {
    id: "delay",
    label: "Consumer refresh lag",
    min: 0,
    max: 180,
    step: 10,
    value: 15,
    unit: " s",
    group: "Consumer",
    help: "Time between rotation and the last consumer using the new credential. This includes polling, deployment, and pool rebuild.",
    format: "number" as const,
  },
  {
    id: "consumers",
    label: "Consumers",
    min: 10,
    max: 100,
    step: 10,
    value: 30,
    unit: " services",
    group: "Scope",
    help: "Number of services that read the secret. Rotation is a distributed deploy, so this is the blast-radius multiplier.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  refresh: boolean;
  grace: number;
  delay: number;
  consumers: number;
  stale: number;
  failureRate: number;
  refreshLag: number;
  secretAge: number;
  appHealth: Health;
  dbHealth: Health;
}

function compute(p: Params): Computed {
  const refresh = num(p, "refresh", 1) >= 0.5;
  const grace = clamp(num(p, "grace", 60), 0, 300);
  const delay = clamp(num(p, "delay", 90), 0, 180);
  const consumers = Math.max(1, Math.round(num(p, "consumers", 30)));
  const stale = !refresh || delay > grace ? consumers : 0;
  const failureRate = (stale / consumers) * 100;
  const refreshLag = refresh ? delay : 0;
  const appHealth: Health = failureRate >= 2 ? "crit" : failureRate > 0 ? "warn" : "ok";
  return {
    refresh,
    grace,
    delay,
    consumers,
    stale,
    failureRate,
    refreshLag,
    secretAge: 45,
    appHealth,
    dbHealth: "ok",
  };
}

function formatPercent(value: number): string {
  return value >= 99.95 ? "100" : value.toFixed(1);
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const rows: [string, number, number][] = [
    ["auth-failures", values.failureRate, 0],
    ["stale-consumers", values.stale, 0],
    ["refresh-lag", values.refreshLag, 1],
    ["secret-age", values.secretAge, 0.4],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) => {
      const wave = Math.sin((index + (seed % 8)) / 2.5) * amplitude;
      return Math.max(0, value + wave);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const failing = values.failureRate >= 2;
  return {
    t: 0,
    nodes: [
      {
        id: "rotation",
        label: "rotation function",
        kind: "worker",
        health: "ok",
        sublabel: "rotation succeeded",
        detail:
          "The rotation function created a new secret version and moved AWSCURRENT. It cannot see which consumers still hold the old credential.",
        meta: { view: "flow" },
      },
      {
        id: "secret",
        label: "orders-db secret",
        kind: "storage",
        health: "ok",
        sublabel: `AWSCURRENT · age ${Math.round(values.secretAge)}s`,
        detail: `The current version is valid. The previous version stays available for ${Math.round(
          values.grace,
        )} seconds of grace in this model. ${SECRET_ARN}`,
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "consumer fleet",
        kind: "service",
        health: values.appHealth,
        sublabel: `${values.stale}/${values.consumers} stale · refresh ${values.refresh ? "on" : "off"}`,
        detail:
          values.stale > 0
            ? `${values.stale} services still present the old credential. Their connection pools were built at startup and were not rebuilt after rotation.`
            : "Every consumer read the current version and rebuilt its pool before the grace window closed.",
        meta: { view: "flow", stale: values.stale },
      },
      {
        id: "db",
        label: "orders database",
        kind: "db",
        health: values.dbHealth,
        sublabel: values.stale > 0 ? "rejecting old credential" : "authenticating current credential",
        detail:
          "The database is available. An authentication failure after rotation is a credential-version mismatch, not a database outage.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("rotation-secret", "rotation", "secret", 1, "ok"),
      edge("app-secret", "app", "secret", values.failureRate >= 2 ? 0.2 : 1, failing ? "crit" : "ok", "GetSecretValue"),
      edge("app-db", "app", "db", values.failureRate >= 2 ? 0.2 : 1, failing ? "crit" : "ok", "TLS + password"),
    ],
    metrics: [
      metric("auth-failures", "Authentication failures", values.failureRate, "%", 0.5, 2, "percent"),
      metric("stale-consumers", "Stale consumers", values.stale, " services", 1, 5, "count"),
      metric("refresh-lag", "Refresh lag", values.refreshLag, " s", 60, 120, "number"),
      metric("secret-age", "Secret age", values.secretAge, " s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatPercent(values.failureRate)}% auth failures; ${values.stale}/${values.consumers} consumers stale; refresh ${
      values.refresh ? "on" : "off"
    }; grace ${Math.round(values.grace)}s.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "auth-failures",
    metricId: "auth-failures",
    warn: 0.5,
    crit: 2,
    title: "Consumers are authenticating with the old secret",
    cause:
      "The rotation succeeded, but one or more consumers kept the credential they loaded at startup. A connection pool does not re-read a secret just because the secret version changed.",
    fix:
      "Enable runtime refresh or restart the consumers after rotation. During the transition, keep the old version valid long enough for every consumer to refresh, then remove it.",
    checkFirst: [
      "Check the database authentication error and the credential version each consumer presents.",
      "Confirm whether the service re-reads the secret or caches it at startup.",
      "Compare the deployment or refresh time with the rotation time.",
    ],
  },
  {
    id: "stale-consumers",
    metricId: "stale-consumers",
    warn: 1,
    crit: 5,
    title: "The consumer fleet did not converge on the new secret",
    cause:
      "Rotation is a distributed deploy. Services refresh on different schedules, and pools, sidecars, and cached SDK clients may hold the old value longer than the secret store.",
    fix:
      "Inventory every consumer, give them a refresh path, and measure convergence. Use a dual-secret window and remove the old version only after the last consumer reports the new one.",
    checkFirst: [
      "List the services, jobs, and third-party integrations that read the secret.",
      "Check refresh configuration and connection-pool lifetime.",
      "Find consumers that only read at startup and need a restart.",
    ],
  },
  {
    id: "refresh-lag",
    metricId: "refresh-lag",
    warn: 60,
    crit: 120,
    title: "Credential refresh is slower than the grace window",
    cause:
      "The consumer refresh lag is longer than the time the previous credential remains valid. Some consumers will fail authentication before they can converge.",
    fix:
      "Shorten the refresh path or lengthen the grace window. A dual-secret rotation keeps both credentials valid while consumers converge.",
    checkFirst: [
      "Measure the time from rotation to the last successful refresh.",
      "Check polling intervals, deployment queues, and pool rebuild time.",
      "Confirm the grace window is longer than the observed convergence time.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const secretsModel: SimModel = {
  id: "cloud-networking-secrets",
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
    const jitter = rng.between(-0.6, 0.6);
    next.metrics = next.metrics.map((item) =>
      item.id === "secret-age" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (values.failureRate >= 2 && frame.flags.staleLogged !== 1) {
      pushEvent(next, {
        id: "stale-credential",
        severity: "crit",
        title: "Stale credential after rotation",
        detail: `${values.stale} of ${values.consumers} consumers still present the previous secret. The rotation succeeded; the consumer fleet did not converge.`,
        nodeId: "app",
        metricId: "auth-failures",
      });
    }
    next.flags.staleLogged = values.failureRate >= 2 ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.stale > 0) {
      items.push(
        `${values.stale} of ${values.consumers} consumers fail authentication. The secret is current; the consumers are holding a previous version or a pool built with it.`,
      );
    } else {
      items.push(
        `All ${values.consumers} consumers converged within the ${Math.round(values.grace)}-second grace window. Refreshing in place avoids a restart wave.`,
      );
    }
    items.push(
      values.refresh
        ? `Runtime refresh is on with a ${Math.round(values.delay)}-second lag. ${
            values.delay > values.grace
              ? "The lag is longer than the grace window, so the fleet cannot converge before the old credential expires."
              : "The lag fits inside the grace window, so the old credential can be removed safely."
          }`
        : "Runtime refresh is off. Every consumer needs a restart to pick up the new version, which turns rotation into a fleet-wide deployment.",
    );
    items.push(
      "Rotation is a distributed deploy. The secret store updates one version; the consumers, connection pools, sidecars, and cached clients each have their own refresh path.",
    );
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
    description: "Consumers refresh within 15 seconds and the old credential remains valid for 120 seconds.",
    tone: "ok",
    params: defaults({ refresh: 1, grace: 120, delay: 15, consumers: 30 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "One hundred consumers refresh at peak traffic; the grace window still covers the lag.",
    tone: "warn",
    params: defaults({ refresh: 1, grace: 120, delay: 45, consumers: 100 }),
  },
  {
    id: "failure",
    label: "Slow refresh",
    description: "Refresh needs 180 seconds but the old credential expires after 60. Consumers fail before they converge.",
    tone: "crit",
    params: defaults({ refresh: 1, grace: 60, delay: 180, consumers: 30 }),
  },
  {
    id: "no-refresh",
    label: "No refresh",
    description: "Consumers read the secret only at startup. Rotation succeeds and every consumer keeps the old credential.",
    tone: "crit",
    params: defaults({ refresh: 0, grace: 300, delay: 0, consumers: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Runtime refresh is restored and the fleet converges inside the grace window.",
    tone: "ok",
    params: defaults({ refresh: 1, grace: 120, delay: 15, consumers: 30 }),
  },
];

const experiment: Experiment = {
  id: "predict-stale-secret",
  title: "Predict who still has the old password",
  simId: "secret-rotation",
  question:
    "The rotation function completed, AWSCURRENT points at the new password, and the database accepts the new credential. Thirty services still fail authentication. What is the most likely cause?",
  prediction: {
    options: [
      { id: "db-down", label: "The database is down, so the new credential cannot be used." },
      { id: "stale", label: "The services cached the old credential or a connection pool built with it." },
      { id: "lambda", label: "The rotation function did not update AWSCURRENT." },
      { id: "kms", label: "The KMS key used to encrypt the secret is disabled." },
    ],
    correctOptionId: "stale",
    explanation:
      "A connection pool is established with the credential that was current when it was created. Updating the secret version does not rebuild the pool. The services continue to present the old password, so the database rejects them. The fix is a refresh path or a restart, plus a grace window long enough for the fleet to converge.",
  },
  setup: defaults({ refresh: 0, grace: 300, delay: 0, consumers: 30 }),
  runFor: 12,
  observe: [
    "The secret node is healthy and AWSCURRENT is the new version.",
    "Every consumer still presents the old credential.",
    "Authentication failures are 100% while the database stays healthy.",
    "The rotation function reports success because it only owns the secret store.",
  ],
  explain:
    "Rotation updates the secret, not the consumers. Each service has its own cache, pool, and restart behavior. The failure looks like a database outage because authentication fails at connect time, but the database is accepting the new credential. The stale consumers are the failing component.",
  fix: defaults({ refresh: 1, grace: 120, delay: 15, consumers: 30 }),
  debrief:
    "A safe rotation is a distributed deploy with a convergence measurement. Keep both credentials valid while consumers refresh, watch the stale count fall to zero, then remove the old version. A rotation that only checks the secret store can succeed while the fleet is down.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A secret is a credential that grants access: a database password, an API key, a token, or a private key. AWS Secrets Manager and AWS Systems Manager Parameter Store can store these values and control who reads them. Secrets Manager can also run a rotation function that creates a new credential and updates the secret version.",
  },
  {
    type: "p",
    text: "Rotation is not a single API call in a working system. The secret store has one version; every consumer has a cache, a connection pool, a sidecar, or a startup read. Updating the store makes the new value available, but it does not make the consumers use it. A rotation plan has to include refresh behavior, a grace window for the old credential, and a way to measure convergence.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is rotation function, secret version, consumer, dependency. The rotation function owns the store and the credential change. The consumer owns the refresh and the pool. The dependency owns whether the old credential still works. A failure can sit in any of the three, and the error often appears at the dependency as an authentication failure.",
  },
  {
    type: "table",
    headers: ["Consumer type", "Refresh path", "Safe pattern", "Risk"],
    rows: [
      ["Long-lived service with a pool", "Re-read on an interval, rebuild the pool", "Dual secret plus refresh", "Pool keeps the old credential."],
      ["Batch job", "Read at start", "Rotate between runs", "A run overlaps the rotation."],
      ["Third-party integration", "Vendor refreshes on its schedule", "Grace window and coordination", "The vendor lags and auth fails."],
      ["Sidecar or proxy", "Reload or restart", "Rolling restart after rotation", "A restart wave becomes an outage."],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Authentication failures as a percentage of consumers, not as a database error count.",
      "Stale consumers: services still presenting the previous credential.",
      "Refresh lag compared with the old-secret grace window.",
      "Four nodes: rotation function, secret, consumer fleet, and database.",
      "A prediction experiment that separates a stale credential from a failed rotation.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply No refresh. The secret node stays healthy while the consumer fleet fails. Next apply Slow refresh and compare the refresh lag with the grace window. Run the experiment before revealing the explanation, then restore Recovery.",
  },
  {
    type: "p",
    text: "The consumer count, grace window, refresh lag, and thresholds are illustrative. The distributed-rotation behavior, the stale-pool failure mode, and the dual-secret pattern are the parts to carry into production.",
  },
  { type: "sim", simId: "secret-rotation" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The rotation function did its job: it created a new version and moved AWSCURRENT. The consumers did not do theirs. Their pools still held the old credential, so the database rejected them. The failure presented as authentication errors, not as a secret-store error.",
  },
  {
    type: "p",
    text: "The slow-refresh preset added the timing dimension. Even with runtime refresh enabled, a lag longer than the grace window leaves a gap where the old credential is gone and the new one is not in use. The fleet converges, but not before some consumers fail.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Secret versions: AWSCURRENT, AWSPREVIOUS, and the rotation timestamp.",
      "Consumer logs: authentication failures at connect time, pool creation, and secret fetch errors.",
      "Deployment and restart history: a restart wave can hide or cause the failure.",
      "Connection pool settings: maximum lifetime, idle timeout, and whether the pool is rebuilt on refresh.",
      "Secret access audit: which identities read which version and when.",
      "Dependency logs: the database or API rejects the old credential, which is the opposite of a dependency outage.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Confirm the secret version and the credential each consumer presents before restarting everything. If the secret is current and the dependency accepts it, the failing component is the consumer's cache or pool. A fleet-wide restart can restore service, but it does not fix the next rotation.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Inventory every consumer, including jobs, sidecars, and third-party integrations.",
      "Give each consumer a refresh path: re-read the secret and rebuild the pool, or restart on a controlled schedule.",
      "Use a dual-secret window so the previous credential stays valid while consumers converge.",
      "Measure the lag from rotation to the last consumer on the new version.",
      "Remove the old version only after the stale count reaches zero.",
      "Keep a rollback path to the previous version if a consumer cannot refresh.",
      "Alert on authentication failures at connect time after a rotation, not only on dependency availability.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Runtime refresh avoids a restart wave but requires every consumer to implement it correctly.",
      "A long grace window reduces outages but keeps a compromised credential valid for longer.",
      "A short grace window is safer for the credential but demands fast convergence and a tested rollback.",
      "Restarting the fleet is simple and predictable, but it is a deployment with its own capacity and availability risk.",
      "A unique secret per consumer narrows the blast radius but multiplies rotation and inventory work.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "design-rotation",
    question:
      "Design a database password rotation for 30 services without a customer-visible outage.",
    difficulty: 3,
    hints: [
      "The secret store is one component; the consumers are many.",
      "Keep both credentials valid during convergence.",
    ],
    answer:
      "I would inventory every consumer and its refresh behavior first. I would use a dual-secret rotation: create the new credential, keep the old one valid, update AWSCURRENT, and let consumers refresh on an interval or a controlled rollout. I would measure the time to the last consumer on the new version and only then remove the old credential. Services that cannot refresh would get a rolling restart before the grace window closes. I would alert on authentication failures at connect time and keep a rollback to the previous version. The rotation function alone is not the design; the convergence plan is.",
    followUps: [
      "How long should the grace window be?",
      "What would you do about a consumer that only reads at startup?",
      "How would you test the plan?",
    ],
    redFlags: [
      "Rotates the password and restarts everything at once.",
      "Assumes the secret store update propagates to pools.",
      "Has no rollback or convergence metric.",
    ],
    rubric: [
      "Inventories consumers.",
      "Uses a dual-secret window.",
      "Measures convergence.",
      "Plans rollback and alerts.",
    ],
  },
  {
    id: "stale-after-rotation",
    question:
      "Rotation succeeded and the database accepts the new password, but services fail authentication. What do you check?",
    difficulty: 2,
    hints: [
      "The failure is at connect time.",
      "A pool is built with the credential that was current then.",
    ],
    answer:
      "I would confirm the secret version and then check what credential each service is presenting. If the database accepts the new password but the services fail, the services are still using the old one. I would look at whether they read the secret at startup, whether they have a refresh loop, and when their connection pools were created. I would also check for sidecars and cached SDK clients that hold a separate copy. The fix is a refresh or a controlled restart, not a database failover.",
    followUps: [
      "Which log line proves the consumer is using the old version?",
      "Would you restart the fleet or fix the refresh path?",
      "How do you prevent the next occurrence?",
    ],
    redFlags: [
      "Fails over the database.",
      "Rotates the secret again.",
      "Restarts everything without finding the stale cache.",
    ],
    rubric: [
      "Checks the credential each consumer presents.",
      "Names startup cache and pool.",
      "Chooses refresh or controlled restart.",
      "Prevents recurrence.",
    ],
  },
  {
    id: "secret-store-choice",
    question: "When would you use Secrets Manager instead of Parameter Store for a credential?",
    difficulty: 2,
    hints: [
      "Rotation is a managed feature.",
      "Both can store strings securely.",
    ],
    answer:
      "I would use Secrets Manager when I need managed rotation, cross-account secret sharing, or fine-grained secret lifecycle features. Parameter Store is a good fit for configuration and for credentials where the team already owns rotation and does not need the managed rotation workflow. The decision is less about storage and more about who owns rotation, how consumers refresh, and what audit and cross-account behavior the integration needs. Either way, the consumer refresh plan is the part that decides whether rotation is safe.",
    followUps: [
      "What does the rotation function need permission to do?",
      "How would cross-account access change the design?",
      "What would you monitor in either service?",
    ],
    redFlags: [
      "Chooses based on price alone.",
      "Assumes storage implies safe rotation.",
      "Ignores consumer refresh.",
    ],
    rubric: [
      "Names managed rotation as a differentiator.",
      "Considers cross-account and audit.",
      "Keeps consumer refresh central.",
      "Avoids a storage-only answer.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every secret has an owner and a list of consumers.",
      "Consumers have a tested refresh path or a controlled restart procedure.",
      "Rotation uses a dual-secret window longer than the measured convergence time.",
      "Authentication failures at connect time are alerted separately from dependency health.",
      "The rotation function has the narrow permissions it needs and a rollback path.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the current secret version and the credential each consumer presents.",
      "Check the dependency's authentication log before failing over.",
      "Refresh or restart the stale consumers in a controlled order.",
      "Keep the old version valid until the stale count reaches zero.",
      "Record the convergence time for the next rotation.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix the consumer that could not refresh.",
      "Adjust the grace window to the measured lag.",
      "Add a rotation drill to the service test plan.",
      "Review secret access and remove unused consumers.",
    ],
  },
];

const references = [
  {
    title: "Rotate AWS Secrets Manager secrets",
    url: "https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Rotation strategies, Lambda rotation functions, and version stages.",
  },
  {
    title: "Secrets Manager best practices",
    url: "https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Recommends rotation, least privilege, and avoiding hard-coded credentials.",
  },
  {
    title: "Manage secrets with AWS Systems Manager Parameter Store",
    url: "https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Secure string parameters and the alternative to Secrets Manager.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "secret-rotation": {
      model: secretsModel,
      presets,
      instructions:
        "Start healthy, then remove runtime refresh and watch the consumer fleet fail while the secret stays current. Compare that with a refresh lag longer than the grace window.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Consumer counts, grace windows, and latency are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["containers-secrets", "cloud-networking-kms", "cloud-networking-iam-roles"],
};
