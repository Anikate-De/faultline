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

const PERIOD_SECONDS = 10;
const FAILURE_THRESHOLD = 3;
const DETECTION_SECONDS = PERIOD_SECONDS * FAILURE_THRESHOLD;
const READY_PODS = 3;

const params: ParamSpec[] = [
  {
    id: "startupSeconds",
    label: "Application startup",
    min: 0,
    max: 180,
    step: 5,
    value: 60,
    unit: "s",
    group: "Application",
    help: "Worst-case time before the process can pass a probe. This is the boot time the probe configuration has to cover.",
    format: "count",
  },
  {
    id: "startupProbeBudget",
    label: "Startup probe budget",
    min: 0,
    max: 240,
    step: 10,
    value: 120,
    unit: "s",
    group: "Startup",
    help: "Total time the startup probe allows before the kubelet restarts the container. Zero means no startup probe. The value is illustrative; the probe's delay, period, and failure threshold produce the real budget.",
    format: "count",
  },
  {
    id: "livenessDelay",
    label: "Liveness initial delay",
    min: 0,
    max: 240,
    step: 5,
    value: 10,
    unit: "s",
    group: "Liveness",
    help: "initialDelaySeconds before the liveness probe starts. Detection adds failureThreshold times periodSeconds; this model uses 30 seconds.",
    format: "count",
  },
  {
    id: "readinessDelay",
    label: "Readiness initial delay",
    min: 0,
    max: 120,
    step: 5,
    value: 10,
    unit: "s",
    group: "Readiness",
    help: "initialDelaySeconds before the readiness probe starts. Readiness failure removes traffic but does not restart the container.",
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

type RestartCause = "startup" | "liveness" | null;

interface Values {
  startup: number;
  startupBudget: number;
  livenessDelay: number;
  readinessDelay: number;
  startupShort: boolean;
  livenessKills: boolean;
  restartCause: RestartCause;
  restarts: number;
  ready: boolean;
  timeToTraffic: number;
  endpoints: number;
  coverage: number;
}

function compute(p: Params): Values {
  const startup = Math.round(clamp(num(p, "startupSeconds", 60), 0, 180));
  const startupBudget = Math.round(clamp(num(p, "startupProbeBudget", 120), 0, 240));
  const livenessDelay = Math.round(clamp(num(p, "livenessDelay", 10), 0, 240));
  const readinessDelay = Math.round(clamp(num(p, "readinessDelay", 10), 0, 120));
  const startupShort = startupBudget > 0 && startupBudget < startup;
  const livenessKills = startupBudget === 0 && livenessDelay + DETECTION_SECONDS < startup;
  const restartCause: RestartCause = startupShort ? "startup" : livenessKills ? "liveness" : null;
  const ready = restartCause === null;
  const timeToTraffic = ready ? Math.max(startup, readinessDelay) : 300;
  const endpoints = ready ? READY_PODS : 0;
  return {
    startup,
    startupBudget,
    livenessDelay,
    readinessDelay,
    startupShort,
    livenessKills,
    restartCause,
    restarts: restartCause ? 3 : 0,
    ready,
    timeToTraffic,
    endpoints,
    coverage: ready ? 100 : 0,
  };
}

function buildFrame(values: Values, seed: number): SimFrame {
  const startupHealth: Health =
    values.startupBudget === 0 ? "warn" : values.startupShort ? "crit" : "ok";
  const livenessHealth: Health = values.livenessKills ? "crit" : "ok";
  const readinessHealth: Health = !values.ready
    ? "crit"
    : values.timeToTraffic > 90
      ? "warn"
      : "ok";
  const pod: Health = values.restartCause ? "crit" : "ok";
  const endpoints: Health = values.ready ? "ok" : "down";
  const client: Health = !values.ready ? "crit" : values.timeToTraffic > 90 ? "warn" : "ok";
  const cause =
    values.restartCause === "startup"
      ? "startup probe budget exhausted"
      : values.restartCause === "liveness"
        ? "liveness probe failed during boot"
        : "";
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: client,
        utilization: clamp(values.coverage / 100),
        sublabel: values.ready ? `${values.endpoints} endpoints available` : "no ready endpoints",
        detail:
          "Clients see no route until readiness succeeds and the pod is published as an endpoint.",
        meta: { view: "flow" },
      },
      {
        id: "endpoints",
        label: "Service endpoints",
        kind: "service",
        health: endpoints,
        utilization: clamp(values.coverage / 100),
        sublabel: `${values.endpoints} ready pods`,
        detail:
          "Readiness controls endpoint membership. A failed liveness check restarts the container and also removes it from endpoints while it is down.",
        meta: { view: "flow" },
      },
      {
        id: "pod",
        label: "Pod: api",
        kind: "service",
        health: pod,
        utilization: clamp(values.ready ? 1 : 0),
        sublabel: values.restartCause
          ? `restart loop: ${cause}`
          : values.ready
            ? `Ready after ${values.timeToTraffic}s`
            : "starting",
        detail: `Application boot is modeled at ${values.startup}s. Readiness traffic begins after ${Math.max(values.startup, values.readinessDelay)}s when the pod is healthy.`,
        meta: { view: "flow" },
      },
      {
        id: "startup-probe",
        label: "Startup probe",
        kind: "service",
        health: startupHealth,
        utilization: clamp(
          values.startupBudget > 0 ? values.startupBudget / Math.max(1, values.startup) : 0,
        ),
        sublabel:
          values.startupBudget === 0
            ? "not configured"
            : `${values.startupBudget}s budget / ${values.startup}s boot`,
        detail:
          "A startup probe runs before liveness and readiness. If it succeeds, the other probes begin. If its budget is exhausted, the kubelet restarts the container.",
        meta: { view: "flow" },
      },
      {
        id: "readiness-probe",
        label: "Readiness probe",
        kind: "service",
        health: readinessHealth,
        utilization: clamp(values.coverage / 100),
        sublabel: `${values.readinessDelay}s delay · ${DETECTION_SECONDS}s detection`,
        detail:
          "Readiness failure removes the pod from Service endpoints without restarting it. It should answer whether this pod can serve traffic now.",
        meta: { view: "flow" },
      },
      {
        id: "liveness-probe",
        label: "Liveness probe",
        kind: "service",
        health: livenessHealth,
        utilization: clamp(values.livenessKills ? 1 : 0),
        sublabel: `${values.livenessDelay}s delay · ${DETECTION_SECONDS}s detection`,
        detail:
          "Liveness failure restarts the container. Liveness should detect a stuck process, not a slow start or a transient dependency.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge(
        "client-endpoints",
        "client",
        "endpoints",
        clamp(values.coverage / 100),
        endpoints,
        "traffic",
      ),
      edge(
        "endpoints-pod",
        "endpoints",
        "pod",
        clamp(values.coverage / 100),
        endpoints,
        "ready only",
      ),
      edge("pod-startup", "pod", "startup-probe", 1, startupHealth, "boot"),
      edge(
        "startup-liveness",
        "startup-probe",
        "liveness-probe",
        clamp(values.startupBudget > 0 ? 1 : 0),
        livenessHealth,
        "unlocks",
      ),
      edge(
        "startup-readiness",
        "startup-probe",
        "readiness-probe",
        clamp(values.startupBudget > 0 ? 1 : 0),
        readinessHealth,
        "unlocks",
      ),
    ],
    metrics: [
      metric("restarts", "Container restarts", values.restarts, " restarts", 0.5, 1, "count"),
      metric(
        "time-to-traffic",
        "Time to first traffic",
        values.timeToTraffic,
        "s",
        90,
        180,
        "number",
      ),
      metric(
        "ready-endpoints",
        "Ready endpoints",
        values.endpoints,
        " pods",
        undefined,
        undefined,
        "count",
      ),
      metric(
        "endpoint-coverage",
        "Endpoint coverage",
        values.coverage,
        "%",
        undefined,
        undefined,
        "percent",
      ),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      ready: values.ready,
      restarts: values.restarts,
      timeToTraffic: values.timeToTraffic,
      cause: values.restartCause ?? "none",
    },
    summary: values.restartCause
      ? `Pod is restarting: ${cause}. ${values.restarts} restarts and zero ready endpoints.`
      : `Pod is Ready after ${values.timeToTraffic}s. ${values.endpoints} endpoints available.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = 0.015 * Math.sin((index + (seed % 4)) / 3.3);
      return Math.max(0, item.value * (1 + wave));
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "restarts",
    metricId: "restarts",
    warn: 0.5,
    crit: 1,
    title: "The container is restarting before it can serve",
    cause:
      "A liveness probe starts before the application can pass it, or a startup probe budget is shorter than the worst-case boot. The kubelet kills the container and starts the same slow boot again, so the pod never reaches readiness.",
    fix: "Add or extend a startup probe so it covers the worst-case boot, and keep liveness out of the boot path. Readiness can start early because it removes traffic without restarting. Do not fix a restart loop by making readiness pass sooner.",
    checkFirst: [
      "Check the pod restart count, last state, and the probe that failed in events.",
      "Compare application startup time with the startup probe budget.",
      "Check whether liveness runs before the startup probe succeeds.",
    ],
  },
  {
    id: "time-to-traffic",
    metricId: "time-to-traffic",
    warn: 90,
    crit: 180,
    title: "The pod takes too long to receive traffic",
    cause:
      "The application boots slowly, or the readiness probe starts so late that endpoint membership lags behind a healthy process. The pod may be running correctly while receiving no Service traffic.",
    fix: "Measure the real boot and first-successful-request time. Set readiness to start early and fail honestly until the pod can serve. Use a startup probe for boot, not a long readiness delay that hides the pod from traffic after it is healthy.",
    checkFirst: [
      "Compare pod Ready time with application startup logs.",
      "Check readiness initial delay, period, and failure threshold.",
      "Check whether the Service has endpoints while the pod is still marked unready.",
    ],
  },
];

export const probesModel: SimModel = {
  id: "probes",
  visual: "flow",
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
      `The application needs ${values.startup}s to boot. The startup probe budget is ${values.startupBudget > 0 ? `${values.startupBudget}s` : "not set"}, and each probe detects failure after about ${DETECTION_SECONDS}s.`,
      `Readiness controls endpoint membership; liveness controls restarts. The modeled time to first traffic is ${values.timeToTraffic}s.`,
    ];
    if (values.restartCause === "startup") {
      items.push(
        `The startup budget ends at ${values.startupBudget}s, before the ${values.startup}s boot completes. The kubelet restarts the container before the application can ever become Ready.`,
      );
    } else if (values.restartCause === "liveness") {
      items.push(
        `Liveness detects failure at about ${values.livenessDelay + DETECTION_SECONDS}s, before the ${values.startup}s boot completes. With no startup probe, the restart loop is the probe configuration, not an application bug.`,
      );
    } else if (values.timeToTraffic > 90) {
      items.push(
        "The pod is healthy, but traffic starts late. Readiness delay or a slow boot delays endpoint membership without causing a restart.",
      );
    } else {
      items.push(
        "The pod becomes Ready inside the traffic budget and no probe restarts it. A successful readiness check is what publishes the endpoint.",
      );
    }
    items.push(
      "Liveness should not check a dependency that can fail independently. A dependency outage should remove traffic through readiness, not restart every pod in a loop.",
    );
    return items;
  },
  legend: [
    { label: "Ready", tone: "ok" },
    { label: "Slow to serve", tone: "warn" },
    { label: "Restart loop or no endpoints", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description:
      "A 60s boot is covered by a 120s startup probe; readiness publishes three endpoints after boot.",
    tone: "ok",
    params: defaults({
      startupSeconds: 60,
      startupProbeBudget: 120,
      livenessDelay: 10,
      readinessDelay: 10,
    }),
  },
  {
    id: "peak",
    label: "Late readiness",
    description:
      "The app boots in 60s but readiness starts after 120s, so traffic waits about 120s without a restart.",
    tone: "warn",
    params: defaults({
      startupSeconds: 60,
      startupProbeBudget: 120,
      livenessDelay: 10,
      readinessDelay: 120,
    }),
  },
  {
    id: "failure",
    label: "Liveness during boot",
    description:
      "A 120s boot has no startup probe. Liveness fails at about 40s and restarts the container before it can become Ready.",
    tone: "crit",
    params: defaults({
      startupSeconds: 120,
      startupProbeBudget: 0,
      livenessDelay: 10,
      readinessDelay: 10,
    }),
  },
  {
    id: "short-startup",
    label: "Short startup budget",
    description:
      "The boot takes 120s but the startup probe allows only 60s. The kubelet restarts before the app is ready.",
    tone: "crit",
    params: defaults({
      startupSeconds: 120,
      startupProbeBudget: 60,
      livenessDelay: 10,
      readinessDelay: 10,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "A startup probe covers the 80s boot and liveness starts only after boot succeeds. Three endpoints are Ready.",
    tone: "ok",
    params: defaults({
      startupSeconds: 80,
      startupProbeBudget: 180,
      livenessDelay: 30,
      readinessDelay: 30,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-restart-loop",
  title: "Predict why a slow-starting pod keeps restarting",
  simId: "probes",
  question:
    "An app needs 120s to boot. It has a liveness probe with a 10s initial delay and a 30s failure window, and no startup probe. It restarts every few minutes and never becomes Ready. Why?",
  prediction: {
    options: [
      {
        id: "liveness",
        label: "Liveness runs during boot and restarts the container before it can pass",
      },
      { id: "readiness", label: "Readiness failure restarts the container" },
      { id: "image", label: "The image pull is slower than the startup budget" },
      { id: "endpoints", label: "The Service has no selector" },
    ],
    correctOptionId: "liveness",
    explanation:
      "Without a startup probe, liveness begins after its initial delay. It fails at about 40s, well before the 120s boot completes, and the kubelet restarts the container. Readiness only removes traffic; it does not restart. The loop is caused by using liveness to police startup.",
  },
  setup: defaults({
    startupSeconds: 120,
    startupProbeBudget: 0,
    livenessDelay: 10,
    readinessDelay: 10,
  }),
  runFor: 60,
  observe: [
    "The container restarts before the application can finish booting.",
    "The pod never holds a Ready condition, so the Service has zero endpoints.",
    "The liveness probe detection window ends around 40s, inside the 120s boot.",
    "Adding a startup probe that covers the boot stops the restart loop.",
  ],
  explain:
    "Liveness answers whether a running process is stuck. It is the wrong probe for a process that is still starting. A startup probe gives the application a boot budget and holds liveness and readiness back until it succeeds. Once startup succeeds, liveness can detect a later hang and readiness can control traffic. That separation is what breaks the loop.",
  fix: defaults({
    startupSeconds: 120,
    startupProbeBudget: 180,
    livenessDelay: 10,
    readinessDelay: 10,
  }),
  debrief:
    "The startup probe covers the worst-case boot, so liveness does not run early. The pod becomes Ready once and the Service publishes three endpoints. The tradeoff is a longer window before a genuinely stuck container is restarted; that is the price of not restarting a slow but healthy boot.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A probe is a check the kubelet runs against a container. Liveness asks whether the process should be restarted. Readiness asks whether the pod should receive Service traffic. Startup asks whether the application has finished booting. The three probes can use HTTP, TCP, or an exec command, and each has its own timing.",
  },
  {
    type: "p",
    text: "The timing fields matter as much as the check. initialDelaySeconds postpones the first probe. periodSeconds sets the interval. timeoutSeconds bounds one attempt. failureThreshold sets how many consecutive failures are needed. The detection window is roughly initial delay plus failure threshold times period, plus the timeout effects. This model uses a 10s period and a failure threshold of 3, so it detects a failure after about 30s.",
  },
  {
    type: "table",
    headers: ["Probe", "Action on failure", "Question it answers", "Common mistake"],
    rows: [
      [
        "Liveness",
        "Restart the container",
        "Is the process stuck?",
        "Checking a slow start or a dependency",
      ],
      [
        "Readiness",
        "Remove the pod from endpoints",
        "Can this pod serve traffic now?",
        "Using readiness to restart a broken process",
      ],
      [
        "Startup",
        "Restart after its budget",
        "Has boot finished?",
        "Setting a budget below worst-case boot",
      ],
    ],
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The kubelet runs the probes on the node and records the results in pod status. The EndpointSlice controller watches readiness and publishes only Ready pods. A liveness failure restarts the container, which also takes it out of endpoints while it is down. A startup probe, when configured, delays both liveness and readiness until it succeeds.",
  },
  {
    type: "p",
    text: "That separation is the design. Liveness protects against a wedged process. Readiness protects users from a pod that cannot serve. Startup protects a slow boot from both. If one probe does all three jobs, a slow start becomes a restart loop and a dependency outage becomes a fleet-wide restart. The model applies one probe configuration to all three replicas, so a restart loop leaves every endpoint unready.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Container restarts: whether a probe or crash is restarting the pod.",
      "Time to first traffic: how long the Service waits for a Ready endpoint.",
      "Ready endpoints: the number of pods published to the Service.",
      "Startup, liveness, and readiness node states, including the detection window.",
      "Endpoint coverage: the share of the desired pods receiving traffic.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Late readiness to see traffic wait without a restart. Apply Liveness during boot and Short startup budget to compare the two restart causes. Run the experiment before revealing the explanation, then apply Recovery.",
  },
  {
    type: "p",
    text: "The question is not which probe is configured, but which action the failure should trigger. If the process is still starting, restarting it makes the boot longer. If the pod is running but cannot serve, removing traffic is enough. If the process is truly stuck, only then should liveness restart it.",
  },
  { type: "sim", simId: "probes" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The liveness-during-boot preset had no startup probe. Liveness detected failure at about 40s while the application needed 120s. The kubelet restarted the container, the same slow boot began again, and the pod never held readiness. The Service had zero endpoints, not because the application was permanently broken, but because the probe restarted it before it could finish starting.",
  },
  {
    type: "p",
    text: "The short-startup preset produced the same loop through a different path: the startup budget expired before boot completed. The recovery preset added a startup probe large enough for the boot, so liveness and readiness began only after startup succeeded. Late readiness showed the non-restarting failure: the pod was healthy but invisible to traffic until the readiness delay expired.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Pod restart count, last state, and the probe failure message in events.",
      "Application startup logs compared with the first Ready timestamp.",
      "Liveness and readiness initial delay, period, timeout, and failure threshold.",
      "EndpointSlice membership while the pod is Running but not Ready.",
      "Whether restarts stop when the startup probe is added or extended.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the application boot time with the liveness detection window and the startup budget. If liveness can fail before boot finishes and no startup probe protects it, fix the probe configuration before touching the application. Then check whether readiness is publishing the pod once it is healthy.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure worst-case boot and first successful request time.",
      "Add or extend a startup probe to cover that boot window.",
      "Keep liveness focused on a stuck process, not on startup or dependencies.",
      "Set readiness to fail until the pod can serve, then let it publish the endpoint.",
      "Verify the pod becomes Ready once instead of restarting in a loop.",
      "Check endpoint membership after the fix, not only the pod phase.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger startup budget avoids false restarts and delays detection of a truly stuck boot.",
      "A readiness probe that checks dependencies protects users and can empty the Service during a dependency outage.",
      "A short liveness window restarts a hung process quickly and risks restarting a healthy but slow request.",
      "Aggressive readiness removes traffic quickly and can thrash endpoints under transient latency.",
      "A startup probe adds configuration and makes the boot contract explicit.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "restart-loop",
    question:
      "A pod restarts every two minutes and never becomes Ready. The application takes 90s to boot. What do you check first?",
    difficulty: 2,
    hints: [
      "Liveness restarts; readiness only removes traffic.",
      "Compare the probe detection window with the boot time.",
    ],
    answer:
      "I would compare the liveness detection window with the 90s boot. If liveness starts before boot can finish and there is no startup probe, the kubelet is restarting a healthy application. I would check the pod events for liveness failures and the restart timestamps against startup logs. The fix is a startup probe that covers worst-case boot, not a longer readiness delay or a higher failure threshold on liveness.",
    followUps: [
      "How would a startup probe change the timeline?",
      "What if the restarts continue after the startup budget is extended?",
      "How would you distinguish a crash from a probe restart?",
    ],
    redFlags: [
      "Raises the liveness failure threshold without measuring boot.",
      "Removes readiness to stop the restarts.",
      "Assumes the image is broken.",
    ],
    rubric: [
      "Separates liveness from readiness.",
      "Compares boot with detection window.",
      "Adds a startup probe.",
      "Checks events and restart timing.",
    ],
  },
  {
    id: "readiness-vs-liveness",
    question:
      "How do you decide whether a failing dependency should fail readiness, liveness, or neither?",
    difficulty: 3,
    hints: [
      "A dependency outage may affect every pod at once.",
      "Restarting does not fix a remote dependency.",
    ],
    answer:
      "A dependency failure should normally affect readiness, not liveness. Readiness removes traffic from pods that cannot serve without restarting them, and it can recover automatically when the dependency returns. Liveness should test the local process, because restarting every pod during a shared dependency outage turns one failure into a restart storm. If the dependency is optional, neither probe should fail; degrade the feature instead.",
    followUps: [
      "What happens if readiness checks a dependency that is slow but not down?",
      "How would you avoid all pods going unready at once?",
      "When would a dependency justify a liveness check?",
    ],
    redFlags: [
      "Puts every dependency in liveness.",
      "Restarts pods to fix a remote outage.",
      "Ignores fleet-wide correlation.",
    ],
    rubric: [
      "Assigns dependency failure to readiness.",
      "Explains restart amplification.",
      "Considers partial degradation.",
      "Separates local process health.",
    ],
  },
  {
    id: "probe-design",
    question:
      "Design probes for a service that has a 60s boot, a 200ms normal request, and a database dependency. What do you set, and why?",
    difficulty: 3,
    hints: [
      "Startup protects boot; readiness protects traffic.",
      "Probe timeouts must be shorter than the failure window you can tolerate.",
    ],
    answer:
      "I would add a startup probe with a budget above the 60s worst-case boot, for example a period and failure threshold that allow several minutes. Liveness would check a local endpoint with a short timeout and a failure threshold that tolerates a few transient failures. Readiness would check the ability to serve, including the database if the service cannot answer without it. I would keep probe timeouts short enough that the detection window fits the traffic budget, and I would test the dependency-outage case to make sure readiness removes traffic without restarting every pod.",
    followUps: [
      "How would you test the dependency-outage behavior?",
      "What would you change for a batch worker with no Service?",
      "How do startup and readiness interact during a rolling update?",
    ],
    redFlags: [
      "Uses liveness for the database.",
      "Sets a startup budget below boot.",
      "Uses the same endpoint for every probe without thinking about actions.",
    ],
    rubric: [
      "Covers boot with startup.",
      "Keeps liveness local.",
      "Uses readiness for serving ability.",
      "Tests the dependency failure.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Worst-case boot time is measured and covered by a startup probe.",
      "Liveness checks the local process, not a shared dependency.",
      "Readiness reflects whether the pod can serve traffic now.",
      "Probe timeouts and failure thresholds fit the traffic budget.",
      "Endpoint membership is monitored while pods are Running but not Ready.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare restart timestamps with application startup logs.",
      "Check which probe failed in pod events.",
      "Compare the liveness detection window with boot time.",
      "Check whether a startup probe exists and whether its budget is long enough.",
      "Check Service endpoints, not only pod phase.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add or extend the startup probe that covers boot.",
      "Remove dependency checks from liveness.",
      "Verify one clean Ready transition and stable endpoint count.",
      "Revisit probe budgets after a slower release or base image change.",
    ],
  },
];

const references = [
  {
    title: "Configure liveness, readiness, and startup probes",
    url: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Probe types, timing fields, and startup probe behavior.",
  },
  {
    title: "Pod lifecycle",
    url: "https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Container states, readiness, restarts, and pod conditions.",
  },
  {
    title: "Site Reliability Workbook",
    url: "https://sre.google/workbook/table-of-contents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Health checking, dependency failure, and avoiding restart amplification.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    probes: {
      model: probesModel,
      presets,
      instructions:
        "Start Healthy, then apply Late readiness to see traffic wait without a restart. Apply Liveness during boot and Short startup budget to compare restart causes. Run the experiment before revealing the explanation, then apply Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 10s probe period, failure threshold of 3, and 30s detection window are fixed teaching values; probe semantics follow the Kubernetes documentation. The same probe configuration applies to all three modeled replicas.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "kubernetes-pods-deployments",
    "kubernetes-requests-limits",
    "containers-health-checks",
    "deployment-verification",
  ],
};
