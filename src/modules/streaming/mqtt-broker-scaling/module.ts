import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "brokers",
    label: "Broker count",
    min: 1,
    max: 8,
    step: 1,
    value: 2,
    unit: "",
    group: "Cluster",
    help: "Brokers behind the load balancer. Adding one changes where new connections land, not where established sessions live.",
    format: "count" as const,
  },
  {
    id: "sessions",
    label: "Connected sessions",
    min: 100,
    max: 50_000,
    step: 100,
    value: 5_000,
    unit: "",
    group: "Clients",
    help: "Persistent MQTT sessions with subscriptions and possibly in-flight QoS 1 or 2 messages.",
    format: "count" as const,
  },
  {
    id: "stateStrategy",
    label: "Session state",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Design",
    help: "0 broker-local, 1 sticky connections with no shared state, 2 shared or replicated session and retained store.",
    format: "count" as const,
  },
  {
    id: "reconnectStorm",
    label: "Reconnect storm",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "1 has the fleet reconnect at once after a broker change. The burst raises connection and authentication load.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  brokers: number;
  sessions: number;
  strategy: number;
  storm: boolean;
  sessionLoss: number;
  retainedLoss: number;
  reconnectErrors: number;
  cpu: number;
  skew: number;
  strategyName: string;
}

function compute(p: Params): Values {
  const brokers = Math.round(clamp(num(p, "brokers", 2), 1, 8));
  const sessions = Math.round(clamp(num(p, "sessions", 5_000), 100, 50_000));
  const strategy = Math.round(clamp(num(p, "stateStrategy", 2), 0, 2));
  const storm = num(p, "reconnectStorm", 0) >= 1;
  const sessionLoss = strategy === 0 ? (1 - 1 / brokers) * 100 : 0;
  const retainedLoss = strategy === 2 ? 0 : strategy === 1 ? 1 : 100;
  const reconnectErrors = storm ? (strategy === 2 ? 2.5 : strategy === 1 ? 9 : 18) : 0;
  const cpu = clamp(15 + sessions / brokers / 250 + (storm ? 30 : 0) + (strategy === 0 ? 15 : 0), 0, 100);
  const skew = strategy === 1 ? 2.4 : 1;
  return {
    brokers,
    sessions,
    strategy,
    storm,
    sessionLoss,
    retainedLoss,
    reconnectErrors,
    cpu,
    skew,
    strategyName: strategy === 0 ? "broker-local state" : strategy === 1 ? "sticky connections" : "shared session store",
  };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const sessionHealth: "ok" | "warn" | "crit" = values.sessionLoss >= 10 ? "crit" : values.sessionLoss >= 1 ? "warn" : "ok";
  const lbHealth = values.reconnectErrors >= 10 ? "crit" : values.reconnectErrors >= 2 ? "warn" : "ok";
  const brokerNodes = Array.from({ length: values.brokers }, (_, index) => {
    const share = values.strategy === 1 && index === values.brokers - 1 ? 0.35 : 1 / values.brokers;
    return {
      id: `broker-${index + 1}`,
      label: `broker-${index + 1}`,
      kind: "stream" as const,
      role: "shard" as const,
      health: index === 0 ? sessionHealth : ("ok" as const),
      utilization: clamp(values.cpu / 100 + (values.strategy === 1 && index === values.brokers - 1 ? 0.15 : 0)),
      throughput: (values.sessions / values.brokers) * share / 600,
      capacity: 200,
      sublabel: `${Math.round((values.sessions * share)).toLocaleString("en-US")} sessions`,
      detail: `Broker ${index + 1} holds ${Math.round(values.sessions * share).toLocaleString("en-US")} sessions. ${values.strategy === 0 ? "These sessions are local to this broker and are not visible to the others." : values.strategy === 1 ? "Connections are sticky; this broker keeps its clients but the new broker gets only new connections." : "Session and retained state are shared, so a reconnect to any broker can resume the session."}`,
      meta: { view: "flow", sessions: Math.round(values.sessions * share) },
    };
  });
  return {
    t: 0,
    nodes: [
      {
        id: "lb",
        label: "TCP load balancer",
        kind: "lb",
        health: lbHealth,
        utilization: clamp(values.cpu / 100),
        throughput: values.storm ? values.sessions / 5 : values.sessions / 600,
        capacity: 1_000,
        sublabel: values.storm ? "reconnect burst" : "steady connections",
        detail: "The load balancer chooses a broker at connect time. It does not move an established session, and it cannot make broker-local state appear on another broker.",
        meta: { view: "flow" },
      },
      ...brokerNodes,
      {
        id: "store",
        label: values.strategy === 2 ? "Shared session store" : "Broker-local store",
        kind: "storage",
        health: values.strategy === 2 ? "ok" : values.sessionLoss >= 10 ? "crit" : "warn",
        utilization: values.strategy === 2 ? 0.5 : 0.8,
        detail: values.strategy === 2
          ? "Sessions, subscriptions, in-flight messages, and retained state are visible to every broker. A reconnect can resume on any node."
          : "State lives inside one broker. When the client reconnects elsewhere, the new broker creates an empty session and the old state is orphaned.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("lb-broker-1", "lb", "broker-1", clamp(values.cpu / 100), lbHealth),
      ...brokerNodes.slice(1).map((broker) => edge(`lb-${broker.id}`, "lb", broker.id, clamp(values.cpu / 100), "ok")),
      ...brokerNodes.map((broker) => edge(`${broker.id}-store`, broker.id, "store", 0.4, "ok")),
    ],
    metrics: [
      metric("session-loss", "Session loss", values.sessionLoss, "%", 1, 10, "percent"),
      metric("retained-loss", "Retained state loss", values.retainedLoss, "%", 1, 10, "percent"),
      metric("reconnect-errors", "Reconnect errors", values.reconnectErrors, "%", 2, 10, "percent"),
      metric("broker-cpu", "Broker CPU", values.cpu, "%", 70, 85, "percent"),
      metric("session-skew", "Session skew", values.skew, "x", 1.5, 2, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, strategy: values.strategy, brokers: values.brokers },
    summary: `${values.strategyName}: ${values.sessionLoss.toFixed(0)}% of sessions lost on redistribution, ${values.reconnectErrors.toFixed(1)}% reconnect errors, ${values.cpu.toFixed(0)}% CPU.`,
  };
}

function seedSeries(frame: SimFrame, values: Values): void {
  for (let index = 0; index < 24; index++) {
    recordSeries(frame, "session-loss", Math.max(0, values.sessionLoss * (0.97 + 0.03 * Math.sin(index / 2.2))));
    recordSeries(frame, "retained-loss", Math.max(0, values.retainedLoss * (0.98 + 0.02 * Math.sin(index / 2.6))));
    recordSeries(frame, "reconnect-errors", Math.max(0, values.reconnectErrors * (0.95 + 0.05 * Math.sin(index / 1.9))));
    recordSeries(frame, "broker-cpu", Math.max(0, values.cpu * (0.98 + 0.02 * Math.sin(index / 2.4))));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "session-loss",
    metricId: "session-loss",
    warn: 1,
    crit: 10,
    title: "Clients reconnected to a broker without their session",
    cause:
      "MQTT session state is broker-local. The load balancer sends a reconnecting client to a different broker, which has no subscriptions, no in-flight messages, and no queued QoS 1 or 2 messages for that client. The client starts a new session.",
    fix:
      "Use a shared or replicated session store, or keep clients on the broker that owns their session with sticky routing. Adding a broker without moving state increases the chance that a reconnect lands on the wrong node.",
    checkFirst: [
      "Check whether the client reconnected to a different broker than before.",
      "Check whether the session was persistent or clean.",
      "Check whether subscriptions and queued messages survived the move.",
    ],
  },
  {
    id: "retained-loss",
    metricId: "retained-loss",
    warn: 1,
    crit: 10,
    title: "Retained state is not available on every broker",
    cause:
      "Retained messages are stored per broker unless the cluster shares or replicates them. A client that lands on a new broker gets no retained value even though another broker has one.",
    fix:
      "Replicate retained state across the cluster or store it in a shared layer. Reconcile after a broker addition before shifting client traffic.",
    checkFirst: [
      "Subscribe to the same topic through each broker and compare retained values.",
      "Check whether retained state is replicated or rebuilt on reconnect.",
      "Check whether the topic is state or an event stream.",
    ],
  },
  {
    id: "reconnect-errors",
    metricId: "reconnect-errors",
    warn: 2,
    crit: 10,
    title: "The reconnect burst is overwhelming the cluster",
    cause:
      "Scaling or failing over forces many clients to reconnect at once. Authentication, TLS handshakes, and subscription replay arrive in a burst, so connection errors rise even when each broker has CPU headroom.",
    fix:
      "Stagger reconnects with jitter and backoff, raise connection limits and authentication capacity, and add brokers before the change rather than during the storm.",
    checkFirst: [
      "Check connection attempts per second and error rate by broker.",
      "Check TLS handshake and authentication latency.",
      "Check whether the client retries in a tight loop.",
    ],
  },
  {
    id: "broker-cpu",
    metricId: "broker-cpu",
    warn: 70,
    crit: 85,
    title: "Broker CPU is saturated during the change",
    cause:
      "Session migration, retained-store replication, and reconnect processing add work on top of normal publish traffic. A sticky strategy can also leave one broker carrying most of the sessions.",
    fix:
      "Drain and rebalance in batches, keep headroom for migration, and watch per-broker session counts rather than the cluster average.",
    checkFirst: [
      "Compare CPU and session count per broker.",
      "Check whether a new broker is receiving new connections only.",
      "Check migration or replication traffic on the network.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const mqttBrokerScalingModel: SimModel = {
  id: "streaming-mqtt-broker-scaling",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()));
    return frame;
  },
  step: (frame, p) => {
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.events = frame.events;
    next.series = frame.series;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      values.strategy === 0
        ? `With broker-local state, redistributing ${values.sessions.toLocaleString("en-US")} sessions across ${values.brokers} brokers loses ${values.sessionLoss.toFixed(0)}% of them.`
        : values.strategy === 1
          ? "Sticky connections keep existing sessions alive, but the new broker receives only new connections and the cluster stays uneven."
          : "Shared state lets a client resume on any broker; the reconnect is a capacity event, not a state-loss event.",
    );
    items.push("A load balancer chooses a broker at connect time. It does not migrate a session that is already established.");
    items.push("Persistent sessions, subscriptions, in-flight QoS messages, and retained messages are separate pieces of state. Check all four, not only the connection count.");
    if (values.storm) items.push("The reconnect storm is the second failure: TLS and authentication work arrives all at once, so connection errors rise even when CPU looks acceptable.");
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
    description: "Two brokers with a shared session store and a steady reconnect rate.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Sticky peak",
    description: "Four brokers with sticky connections and a reconnect storm; no sessions lost, but the cluster is uneven.",
    tone: "warn",
    params: defaults({ brokers: 4, sessions: 30_000, stateStrategy: 1, reconnectStorm: 1 }),
  },
  {
    id: "failure",
    label: "Add a broker",
    description: "Four brokers with broker-local state; the fleet reconnects and three quarters of sessions are orphaned.",
    tone: "crit",
    params: defaults({ brokers: 4, sessions: 20_000, stateStrategy: 0, reconnectStorm: 1 }),
  },
  {
    id: "recovery",
    label: "Shared state",
    description: "Four brokers backed by a shared session and retained store, with a controlled reconnect.",
    tone: "ok",
    params: defaults({ brokers: 4, sessions: 30_000, stateStrategy: 2, reconnectStorm: 0 }),
  },
  {
    id: "storm",
    label: "Reconnect storm",
    description: "Shared state but every client reconnects at once; state survives while connection errors spike.",
    tone: "crit",
    params: defaults({ brokers: 4, sessions: 30_000, stateStrategy: 2, reconnectStorm: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-session-loss",
  title: "Predict what happens to sessions on a new broker",
  simId: "mqtt-broker-scaling",
  question:
    "Two brokers hold 5k persistent sessions with broker-local state. You add a third broker and clients reconnect through the load balancer. What happens to the existing sessions?",
  prediction: {
    options: [
      { id: "moved", label: "They move with the clients and resume on the new broker" },
      { id: "third-lost", label: "About one third reconnect to a broker that has no session for them and start clean" },
      { id: "all-lost", label: "Every session is lost because the cluster rebalances" },
      { id: "none", label: "Nothing changes; sessions are replicated by the load balancer" },
    ],
    correctOptionId: "third-lost",
    explanation:
      "Session state lives inside each broker. When a client reconnects and the load balancer picks a different broker, that broker has no subscriptions or queued messages for the client, so the session starts clean. With two old brokers and one new one, roughly one third of reconnects land on the new broker.",
  },
  setup: defaults({ brokers: 3, sessions: 5_000, stateStrategy: 0, reconnectStorm: 0 }),
  runFor: 20,
  observe: [
    "Session loss is the share of clients that land on a broker without their state.",
    "Subscription replay and queued QoS messages disappear with the session.",
    "A shared store removes session loss even when clients move.",
    "Sticky routing avoids loss for existing clients but leaves the new broker underused.",
  ],
  explain:
    "MQTT sessions are scoped to a broker unless the cluster replicates them. The clean-session flag controls whether the broker keeps state after disconnect, but it does not move that state between brokers. Scaling therefore needs a state strategy: shared storage, cluster replication, or sticky routing with a drain plan. Retained messages need the same treatment.",
  fix: defaults({ brokers: 3, sessions: 5_000, stateStrategy: 2, reconnectStorm: 0 }),
  debrief:
    "The fix moves session and retained state into a shared or replicated layer before adding the broker. Clients can resume anywhere, and session loss drops to zero. The remaining cost is the reconnect burst and the work of replicating state on every change.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An MQTT broker holds more than open sockets. For each persistent client session it keeps subscriptions, the next packet identifier, in-flight QoS 1 and 2 messages, and queued messages. It also keeps retained messages per topic. Those are separate pieces of state, and by default they live inside one broker process.",
  },
  {
    type: "p",
    text: "Scaling adds brokers, but a load balancer only chooses a broker when a connection is established. Existing clients stay where they are, and a reconnecting client may land on a broker that has never seen its session. The result is a clean session, lost subscriptions, and a retained topic that appears empty. The broker count went up; the state did not move.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, load balancer, broker, session store. A bridge forwards messages between brokers but does not by itself make sessions portable. A cluster with a shared or replicated store can resume a session on any node; sticky routing keeps a client on one node, which avoids loss for existing clients but leaves new brokers underused.",
  },
  {
    type: "table",
    headers: ["Strategy", "Session on reconnect", "Retained state", "Main cost"],
    rows: [
      ["Broker-local", "Lost if the client lands elsewhere", "Per broker", "Simple until you scale or fail over"],
      ["Sticky connections", "Kept while the client stays on its broker", "Per broker", "Uneven load and a hard drain problem"],
      ["Shared or replicated state", "Resumes on any broker", "Visible cluster-wide", "Replication traffic and consistency work"],
    ],
  },
  {
    type: "p",
    text: "This module uses up to 50k sessions and eight brokers. Those are illustrative teaching values. The shape of the failure is the lesson: the load balancer moves the connection, not the session, and the client silently starts over.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Session loss: the share of clients whose reconnect finds no session. Warning at 1%, critical at 10%.",
      "Retained state loss: whether the new broker can serve the last value for a topic.",
      "Reconnect errors: TLS, authentication, and subscription replay during a burst. Warning at 2%, critical at 10%.",
      "Broker CPU and session skew, which show whether the cluster is actually balanced.",
      "A flow view with the load balancer, each broker, and the session store.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply Add a broker. Run the experiment before changing the state strategy. Compare Sticky peak and Reconnect storm, and watch session loss separately from reconnect errors.",
  },
  { type: "sim", simId: "mqtt-broker-scaling" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With four brokers and broker-local state, 75% of sessions were lost when clients redistributed. The client reconnected successfully at the TCP level, which is why connection dashboards looked healthy, but the new broker had no subscriptions or queued messages. Retained values were missing for the same reason. The failure was state placement, not broker capacity.",
  },
  {
    type: "p",
    text: "The shared store removed session loss: a reconnect resumed on any broker, and retained values were visible cluster-wide. Sticky routing also kept existing sessions alive, but the newest broker received only new connections, so session counts and CPU stayed uneven. The reconnect storm remained a separate capacity problem even with shared state.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-broker session counts, connection counts, and subscription counts. A new broker at zero sessions is not carrying its share.",
      "Client logs showing a clean-session start, resubscribe, and missing queued messages after a reconnect.",
      "Broker logs for session takeover, session expiry, and retained-store misses.",
      "Authentication and TLS handshake latency during the change.",
      "Retained value checks through each broker for the same topic.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Confirm the client landed on a different broker. Check whether the session was persistent and whether the cluster shares state. Then check retained values through each node. Do not add more brokers until the state strategy is settled.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Inventory the state: sessions, subscriptions, in-flight messages, queued messages, and retained topics.",
      "Choose shared or replicated state if clients must resume on any broker.",
      "If state stays local, use sticky routing and drain one broker at a time with a planned reconnect.",
      "Add brokers before the traffic change, not during a reconnect storm.",
      "Stagger client reconnects with jitter and backoff, and raise authentication capacity.",
      "Verify session resume and retained values through every broker before shifting production traffic.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Shared state removes reconnect loss but adds replication traffic and a consistency surface.",
      "Sticky routing is simple but leaves new brokers underused and makes drains slow.",
      "Clean sessions reduce broker memory but guarantee a resubscribe and a gap after reconnect.",
      "Persistent sessions preserve queued messages but increase memory and reconnect cost.",
      "Adding brokers during a storm increases capacity and connection errors at the same time.",
      "Bridging improves locality but can duplicate messages if subscriptions overlap.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-session-lost",
    question:
      "A client reconnects after a broker is added and reports that all its subscriptions are gone. The broker is healthy. What happened?",
    difficulty: 2,
    hints: [
      "The load balancer chose a different broker.",
      "Subscriptions are part of session state.",
    ],
    answer:
      "The client landed on a broker that did not hold its session. Subscriptions, queued messages, and in-flight QoS state are broker-local by default, so the new broker created a clean session. The connection succeeded, which is why health checks looked fine. I would confirm the previous and current broker, check whether the session was persistent, and check whether the cluster shares session state. The fix is shared state or sticky routing, not a client resubscribe loop.",
    followUps: [
      "How would retained messages behave in the same move?",
      "What does a clean-session flag change?",
      "How would you test this before production?",
    ],
    redFlags: [
      "Blames the client library.",
      "Adds brokers without checking state.",
      "Confuses TCP reconnect with session resume.",
    ],
    rubric: [
      "Names broker-local session state.",
      "Explains the load balancer's role.",
      "Proposes shared state or sticky routing.",
    ],
  },
  {
    id: "sticky-vs-shared",
    question:
      "Compare sticky sessions with a shared session store for an MQTT cluster. When would you choose each?",
    difficulty: 3,
    hints: [
      "Sticky keeps a client on one broker.",
      "Shared state lets any broker serve the session.",
    ],
    answer:
      "Sticky sessions keep each client on one broker, which preserves local state and avoids replication. They are a good fit when clients reconnect rarely and the cluster can tolerate uneven load. Shared state lets any broker resume a session, which is better for elastic scaling, rolling upgrades, and fast failover, but it adds replication traffic and consistency handling. I would choose sticky for a small stable fleet and shared state when broker addition or failure must not lose sessions.",
    followUps: [
      "What happens to a sticky client when its broker dies?",
      "Which state is hardest to replicate?",
      "How do retained messages change the decision?",
    ],
    redFlags: [
      "Treats sticky as highly available.",
      "Ignores retained state.",
      "Assumes shared state is free.",
    ],
    rubric: [
      "States the failure behavior of each.",
      "Connects the choice to scaling and failover.",
      "Names replication cost.",
    ],
  },
  {
    id: "reconnect-storm",
    question:
      "You moved to shared state, but reconnect errors spike during the broker rollout. What do you check?",
    difficulty: 3,
    hints: [
      "State is not the only cost of reconnecting.",
      "TLS, authentication, and subscription replay arrive together.",
    ],
    answer:
      "I would check connection attempts per second, TLS handshake time, authentication latency, and subscription replay volume. Shared state fixes session loss but not the burst of work when every client reconnects at once. I would stagger reconnects with jitter, add authentication capacity, keep broker headroom, and roll one broker at a time. If clients retry in a tight loop, I would fix the backoff before adding capacity.",
    followUps: [
      "How would you test the burst in staging?",
      "Which metric shows authentication as the bottleneck?",
      "Would you drain clients or restart brokers?",
    ],
    redFlags: [
      "Adds brokers without fixing retry behavior.",
      "Focuses only on session state.",
      "Ignores TLS and auth capacity.",
    ],
    rubric: [
      "Separates state loss from connection burst.",
      "Names auth, TLS, and replay as costs.",
      "Proposes jitter and staged rollout.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Session, subscription, in-flight, and retained state are inventoried.",
      "The cluster has a documented state strategy and a tested broker-addition runbook.",
      "Retained values are checked through every broker.",
      "Client reconnect backoff and jitter are configured.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm whether the client changed brokers and whether its session resumed.",
      "Check retained values through the new broker.",
      "Watch reconnect errors separately from session loss.",
      "Pause further broker changes until state behavior is understood.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify session resume and retained state through every node.",
      "Run a broker drain and reconnect test with production-like client counts.",
      "Document the state that is shared and the state that remains local.",
    ],
  },
];

const references = [
  {
    title: "HiveMQ documentation: clustering",
    url: "https://docs.hivemq.com/hivemq/latest/user-guide/cluster.html",
    publisher: "HiveMQ",
    kind: "docs" as const,
    note: "Cluster state, session replication, and retained message behavior.",
  },
  {
    title: "EMQX documentation: cluster introduction",
    url: "https://docs.emqx.com/en/emqx/latest/deploy/cluster/introduction.html",
    publisher: "EMQX",
    kind: "docs" as const,
    note: "Broker clustering, session persistence, and load distribution.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "mqtt-broker-scaling": {
      model: mqttBrokerScalingModel,
      presets,
      instructions:
        "Start healthy, apply Add a broker, then run the experiment. Compare Sticky peak, Shared state recovery, and Reconnect storm. Watch session loss and reconnect errors separately.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Session counts, CPU, and reconnect rates are teaching values, not broker benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["streaming-mqtt-qos", "streaming-mqtt-fanout", "streaming-mqtt-retained"],
};
