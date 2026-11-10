import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, Rng, SimFrame, SimModel, SimPreset } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const PRODUCE_RATE = 15_000;
const SCALE_AT = 6;
const MAX_LAG = 5_000_000;

const params = [
  {
    id: "partitions",
    label: "Partitions",
    min: 6,
    max: 24,
    step: 1,
    value: 12,
    unit: "",
    group: "Topic",
    help: "Partition count. A rebalance reassigns these units; more partitions mean more work per rebalance.",
    format: "count" as const,
  },
  {
    id: "members",
    label: "Group members",
    min: 2,
    max: 12,
    step: 1,
    value: 8,
    unit: "",
    group: "Consumer group",
    help: "Consumers in the group before the scale-up event. One member owns each assigned partition.",
    format: "count" as const,
  },
  {
    id: "consumerRate",
    label: "Consumer throughput",
    min: 500,
    max: 5_000,
    step: 250,
    value: 3_000,
    unit: " rec/s",
    group: "Consumer group",
    help: "Records per second one member processes. Capacity is members times this rate, capped by partitions.",
    format: "rps" as const,
  },
  {
    id: "sessionTimeout",
    label: "Session timeout",
    min: 10,
    max: 60,
    step: 5,
    value: 45,
    unit: " s",
    group: "Protocol",
    help: "How long the group waits for a member before treating it as failed. A pause longer than this can trigger an eviction and a second rebalance.",
    format: "count" as const,
  },
  {
    id: "cooperative",
    label: "Cooperative protocol",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Protocol",
    help: "0 uses the eager protocol, which revokes every partition. 1 uses incremental cooperative assignment, which revokes only moving partitions.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function flagNumber(flags: SimFrame["flags"], id: string, fallback = 0): number {
  const value = flags[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface State {
  lag: number;
  scaleDone: number;
  rebalances: number;
  paused: number;
  pauseRemaining: number;
  pauseTotal: number;
  sessionEvictions: number;
}

function readState(flags: SimFrame["flags"]): State {
  return {
    lag: Math.max(0, flagNumber(flags, "lag")),
    scaleDone: flagNumber(flags, "scaleDone"),
    rebalances: flagNumber(flags, "rebalances"),
    paused: flagNumber(flags, "paused"),
    pauseRemaining: Math.max(0, flagNumber(flags, "pauseRemaining")),
    pauseTotal: Math.max(0, flagNumber(flags, "pauseTotal")),
    sessionEvictions: flagNumber(flags, "sessionEvictions"),
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function worstHealth(a: "ok" | "warn" | "crit", b: "ok" | "warn" | "crit"): "ok" | "warn" | "crit" {
  const rank = { ok: 0, warn: 1, crit: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function pauseFor(p: Params): number {
  const members = Math.max(2, Math.round(num(p, "members", 8)));
  const partitions = Math.max(2, Math.round(num(p, "partitions", 12)));
  const eager = 4 + members * 2 + partitions * 0.5;
  return num(p, "cooperative", 1) >= 1 ? Math.max(1, eager * 0.22) : eager;
}

function capacityFor(p: Params, addedMembers: number): number {
  const partitions = Math.max(1, Math.round(num(p, "partitions", 12)));
  const members = Math.max(1, Math.round(num(p, "members", 8)));
  const rate = Math.max(100, num(p, "consumerRate", 3_000));
  return Math.min(partitions, members + addedMembers) * rate;
}

function capacityDuring(p: Params, state: State, addedMembers: number): number {
  const full = capacityFor(p, addedMembers);
  if (state.paused !== 1) return full;
  return num(p, "cooperative", 1) >= 1 ? full * 0.5 : 0;
}

function buildFrame(p: Params, seed: number, state: State, flags: SimFrame["flags"]): SimFrame {
  const partitions = Math.max(2, Math.round(num(p, "partitions", 12)));
  const members = Math.max(2, Math.round(num(p, "members", 8)));
  const rate = Math.max(100, num(p, "consumerRate", 3_000));
  const added = state.scaleDone === 1 ? 1 : 0;
  const effectiveMembers = Math.min(partitions, members + added);
  const capacity = capacityDuring(p, state, added);
  const pause = state.paused === 1 ? state.pauseTotal : 0;
  const lag = Math.max(0, state.lag);
  const groupHealth = worstHealth(healthFor(lag, 100_000, 500_000), healthFor(pause, 10, 20));
  const utilisation = capacity > 0 ? clamp(PRODUCE_RATE / capacity) : 1;
  const consumedRate = state.paused === 1 ? capacity : lag > 0 ? capacity : Math.min(capacity, PRODUCE_RATE);
  return {
    t: 0,
    nodes: [
      {
        id: "producer",
        label: "Orders producer",
        kind: "service",
        health: "ok",
        utilization: 0.55,
        throughput: PRODUCE_RATE,
        sublabel: `${PRODUCE_RATE.toLocaleString("en-US")} rec/s`,
        meta: { view: "flow" },
      },
      {
        id: "topic",
        label: "orders topic",
        kind: "stream",
        health: groupHealth === "crit" ? "warn" : "ok",
        throughput: PRODUCE_RATE,
        sublabel: `${partitions} partitions`,
        detail: "Records stay in the log while consumers are paused. The topic does not stop accepting writes during a rebalance.",
        meta: { view: "flow" },
      },
      {
        id: "group",
        label: "orders-consumers",
        kind: "worker",
        health: groupHealth,
        utilization: utilisation,
        throughput: consumedRate,
        capacity,
        sublabel: state.paused === 1 ? "rebalancing · paused" : `${effectiveMembers} active · ${Math.round(capacity).toLocaleString("en-US")} rec/s`,
        detail:
          state.paused === 1
            ? `The group is paused for about ${state.pauseTotal.toFixed(1)} seconds while partitions are revoked and reassigned.`
            : `${effectiveMembers} members process at ${Math.round(rate).toLocaleString("en-US")} rec/s each.`,
        meta: {
          paused: state.paused,
          pause: state.pauseTotal,
          members: effectiveMembers,
          lag,
        },
      },
    ],
    edges: [
      edge("producer-topic", "producer", "topic", 0.75, "ok"),
      edge("topic-group", "topic", "group", state.paused === 1 ? 0 : clamp(PRODUCE_RATE / Math.max(1, capacity)), groupHealth),
    ],
    metrics: [
      metric("rebalance-pause", "Rebalance pause", pause, " s", 10, 20, "count"),
      metric("consumer-lag", "Consumer lag", lag, " records", 100_000, 500_000, "count"),
      metric("processing-capacity", "Processing capacity", capacity, " rec/s", undefined, undefined, "rps"),
      metric("produce-rate", "Produce rate", PRODUCE_RATE, " rec/s", undefined, undefined, "rps"),
      metric(
        "paused-members",
        "Paused members",
        state.paused === 1
          ? num(p, "cooperative", 1) >= 1
            ? Math.max(1, Math.ceil(effectiveMembers / 2))
            : effectiveMembers
          : 0,
        "",
        undefined,
        undefined,
        "count",
      ),
    ],
    events: [],
    series: {},
    flags: {
      ...flags,
      seed,
      lag,
      scaleDone: state.scaleDone,
      rebalances: state.rebalances,
      paused: state.paused,
      pauseRemaining: state.pauseRemaining,
      pauseTotal: state.pauseTotal,
      sessionEvictions: state.sessionEvictions,
    },
    summary:
      state.paused === 1
        ? `Group paused for a rebalance; ${Math.round(pause)}s total pause and ${Math.round(lag).toLocaleString("en-US")} records behind.`
        : `${effectiveMembers} members consuming; ${Math.round(lag).toLocaleString("en-US")} records behind at ${PRODUCE_RATE.toLocaleString("en-US")} rec/s produced.`,
  };
}

function seedSeries(frame: SimFrame, state: State, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.4);
  const values: [string, number][] = [
    ["rebalance-pause", state.paused === 1 ? state.pauseTotal : 0],
    ["consumer-lag", state.lag],
    ["processing-capacity", 0],
    ["produce-rate", PRODUCE_RATE],
    ["paused-members", state.paused === 1 ? 1 : 0],
  ];
  for (const [id, value] of values) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

function advance(
  state: State,
  p: Params,
  t: number,
  dt: number,
  rng: Rng,
): { next: State; started: boolean; evicted: boolean; completed: boolean } {
  const next = { ...state };
  const produce = PRODUCE_RATE * (1 + rng.between(-0.01, 0.01));
  let started = false;
  let evicted = false;
  let completed = false;

  if (next.scaleDone !== 1 && t >= SCALE_AT) {
    started = true;
    next.scaleDone = 1;
    next.rebalances += 1;
    next.pauseTotal = pauseFor(p);
    next.pauseRemaining = next.pauseTotal;
    next.paused = 1;
  }

  if (next.paused === 1) {
    const partial = capacityDuring(p, next, next.scaleDone === 1 ? 1 : 0);
    const available = next.lag + produce * dt;
    const consumed = Math.min(partial * dt, available);
    next.lag = Math.max(0, Math.min(MAX_LAG, available - consumed));
    next.pauseRemaining = Math.max(0, next.pauseRemaining - dt);
    if (next.pauseRemaining <= 0) {
      next.paused = 0;
      next.pauseRemaining = 0;
      completed = true;
      const session = Math.max(1, num(p, "sessionTimeout", 45));
      if (next.pauseTotal > session && next.sessionEvictions < 1) {
        next.sessionEvictions = 1;
        next.rebalances += 1;
        const extra = Math.max(2, next.pauseTotal * 0.5);
        next.pauseTotal += extra;
        next.pauseRemaining = extra;
        next.paused = 1;
        evicted = true;
      }
    }
  } else {
    const capacity = capacityFor(p, next.scaleDone === 1 ? 1 : 0);
    const available = next.lag + produce * dt;
    const consumed = Math.min(capacity * dt, available);
    next.lag = Math.max(0, Math.min(MAX_LAG, available - consumed));
  }

  return { next, started, evicted, completed };
}

export const rebalancingModel: SimModel = {
  id: "streaming-rebalancing",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const state: State = {
      lag: 0,
      scaleDone: 0,
      rebalances: 0,
      paused: 0,
      pauseRemaining: 0,
      pauseTotal: 0,
      sessionEvictions: 0,
    };
    const frame = buildFrame(defaults(), seed, state, {});
    seedSeries(frame, state, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const previous = readState(frame.flags);
    const seconds = Math.min(1, Math.max(0.01, dt));
    const { next, started, evicted, completed } = advance(previous, p, frame.t, seconds, rng);
    const result = buildFrame(p, Number(frame.flags.seed ?? 20261110), next, frame.flags);
    result.t = frame.t;
    result.series = frame.series;
    result.events = frame.events;

    if (started) {
      pushEvent(result, {
        id: `rebalance-started-${next.rebalances}`,
        at: frame.t,
        severity: "warn",
        title: "The consumer group entered a rebalance",
        detail:
          num(p, "cooperative", 1) >= 1
            ? "Partitions that must move are revoked first; members that keep their partitions continue fetching. The pause is shorter than an eager rebalance but not zero."
            : "Every member revoked every partition. Fetching and processing stop until the new assignment is installed.",
        nodeId: "group",
        metricId: "rebalance-pause",
      });
    }
    if (evicted) {
      pushEvent(result, {
        id: `rebalance-started-${next.rebalances}`,
        at: frame.t,
        severity: "warn",
        title: "A second rebalance started after the eviction",
        detail: `The group removed the paused member and began another assignment round. Another pause is now in progress.`,
        nodeId: "group",
        metricId: "rebalance-pause",
      });
      pushEvent(result, {
        id: "session-timeout-eviction",
        at: frame.t,
        severity: "crit",
        title: "A paused member exceeded the session timeout",
        detail: `The ${next.pauseTotal.toFixed(0)}s pause is longer than the ${Math.round(num(p, "sessionTimeout", 45))}s session timeout. The group evicted a member and started another rebalance, adding another pause.`,
        nodeId: "group",
        metricId: "consumer-lag",
      });
    }
    if (completed && !evicted) {
      pushEvent(result, {
        id: `rebalance-complete-${next.rebalances}`,
        at: frame.t,
        severity: "info",
        title: "The group resumed processing",
        detail: `The new assignment is active. Lag built during the pause now drains at the difference between consumer capacity and the produce rate.`,
        nodeId: "group",
        metricId: "consumer-lag",
      });
    }

    for (const item of result.metrics) recordSeries(result, item.id, item.value);
    result.flags.lagWarned = next.lag >= 100_000 ? 1 : 0;
    return result;
  },
  thresholds: [
    {
      id: "rebalance-pause",
      metricId: "rebalance-pause",
      warn: 10,
      crit: 20,
      title: "A rebalance is long enough to matter",
      cause:
        "The group is revoking and reassigning partitions. Eager assignment revokes every partition, so every member stops fetching until the new assignment arrives. Group size, partition count, and rejoin time set the length of the pause.",
      fix:
        "Switch to a cooperative assignor to revoke only moving partitions, scale in smaller steps, and keep members alive with heartbeats and timely poll calls. If the pause exceeds the session or poll timeout, fix the pause before raising the timeout.",
      checkFirst: [
        "Check which assignor the group uses and whether every member supports it.",
        "Compare the pause with session.timeout.ms and max.poll.interval.ms.",
        "Check whether one member is slow to rejoin and holding the group in the rebalance.",
      ],
    },
    {
      id: "consumer-lag",
      metricId: "consumer-lag",
      warn: 100_000,
      crit: 500_000,
      title: "The rebalance backlog is now a freshness risk",
      cause:
        "Production continued while consumption stopped. Lag is the integral of the produce rate over the pause, minus any drain after it. A pause that looks short still creates a large backlog at high throughput.",
      fix:
        "Shorten the pause, then verify that consumer capacity exceeds the produce rate so the backlog drains. If the backlog cannot drain, add capacity or slow the producer; a second rebalance will only add more lag.",
      checkFirst: [
        "Graph lag before, during, and after the rebalance.",
        "Confirm that capacity is above the produce rate after the assignment settles.",
        "Check whether a timeout eviction caused a second pause.",
      ],
    },
  ],
  insights: (frame, p) => {
    const state = readState(frame.flags);
    const pause = pauseFor(p);
    const capacity = capacityFor(p, 1);
    const items: string[] = [];
    items.push(
      `A membership change revokes partitions before it reassigns them; in this model the ${num(p, "cooperative", 1) >= 1 ? "cooperative" : "eager"} pause is about ${pause.toFixed(1)}s.`,
    );
    items.push(
      `Post-rebalance capacity is ${Math.round(capacity).toLocaleString("en-US")} rec/s against ${PRODUCE_RATE.toLocaleString("en-US")} rec/s produced, so the backlog ${capacity > PRODUCE_RATE ? "drains" : "keeps growing"} after the pause.`,
    );
    if (num(p, "cooperative", 1) < 1) {
      items.push("Eager assignment revokes every partition from every member; the pause is group-wide even when only one member joined.");
    } else {
      items.push("Cooperative assignment revokes only the partitions that must move; the members that keep theirs keep processing.");
    }
    if (pause > num(p, "sessionTimeout", 45)) {
      items.push("The modeled pause is longer than the session timeout, which can evict a member and trigger another rebalance.");
    }
    items.push(`Lag is ${Math.round(state.lag).toLocaleString("en-US")} records; the pause is a spike, but the drain rate decides how long it lasts.`);
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Cooperative rebalance, eight members, and enough capacity to absorb the pause.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Five members and ten partitions create a 19-second eager pause; the backlog warns but drains.",
    tone: "warn",
    params: defaults({ members: 5, cooperative: 0, partitions: 10, consumerRate: 3_000 }),
    elapsed: 26.2,
  },
  {
    id: "failure",
    label: "40-second pause",
    description: "Twelve members and twenty-four partitions under eager assignment: the group pauses for 40 seconds.",
    tone: "crit",
    params: defaults({ members: 12, cooperative: 0, partitions: 24, consumerRate: 3_000 }),
    elapsed: 6.2,
  },
  {
    id: "recovery",
    label: "Cooperative recovery",
    description: "Cooperative assignment with ten members and headroom; the remaining capacity covers production during the move.",
    tone: "ok",
    params: defaults({ members: 10, cooperative: 1, partitions: 20, consumerRate: 3_000 }),
  },
  {
    id: "timeout",
    label: "Timeout eviction",
    description: "A 22-second eager pause against a 10-second session timeout triggers a second rebalance.",
    tone: "warn",
    params: defaults({ members: 6, cooperative: 0, partitions: 12, consumerRate: 3_000, sessionTimeout: 10 }),
  },
];

const experiment: Experiment = {
  id: "predict-rebalance-pause",
  title: "Predict what one new consumer costs",
  simId: "rebalancing",
  question:
    "The group has 12 members and 24 partitions on the eager protocol. One consumer joins. Processing pauses for 40 seconds and lag jumps. Which change removes most of that pause?",
  prediction: {
    options: [
      { id: "more-members", label: "Add another consumer so the group rebalances faster" },
      { id: "cooperative", label: "Switch to a cooperative assignor so only moving partitions are revoked" },
      { id: "raise-timeout", label: "Raise the session timeout so the pause is allowed" },
      { id: "more-partitions", label: "Add partitions so each member has less work" },
    ],
    correctOptionId: "cooperative",
    explanation:
      "The pause is caused by revoking every partition from every member, not by a shortage of members or partitions. Cooperative assignment keeps the partitions that are not moving with their current owners, so most members keep processing. Raising the timeout only lets a long pause happen without an eviction; it does not shorten the pause.",
  },
  setup: defaults({ members: 12, cooperative: 0, partitions: 24, consumerRate: 3_000 }),
  runFor: 55,
  observe: [
    "The pause metric holds at 40 seconds while the group is rebalancing.",
    "Lag grows at the full produce rate because every member stopped consuming.",
    "The group resumes with more capacity, but the backlog takes time to drain.",
    "The topic keeps accepting writes; only the consumer side stops.",
  ],
  explain:
    "An eager rebalance is a barrier: every member gives up every partition, then the group waits for all members to rejoin before assigning work again. The pause is the rebalance, not the new member's processing. Cooperative assignment is incremental: the leader revokes only the partitions that need a new owner, and members that keep their partitions continue fetching. The remaining pause is still real, so capacity and lag after the rebalance still matter.",
  fix: defaults({ members: 12, cooperative: 1, partitions: 24, consumerRate: 3_000 }),
  debrief:
    "With cooperative assignment the modeled pause falls from 40 seconds to about 9 seconds, and the members that keep their partitions keep processing at roughly half capacity. At 36k rec/s of pre-scale capacity, that remaining 18k rec/s covers the 15k produced, so this run forms no backlog at all. The tradeoff is that cooperative assignment needs every member to support the protocol, and a partition can move through an intermediate owner, so the group may rebalance more than once during a rollout.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Kafka consumer group divides the partitions of a topic among its members. Each partition is assigned to one member at a time. A rebalance is the group's process for redistributing those assignments when membership or subscriptions change: a consumer starts, stops, crashes, or the topic gains a partition. During the rebalance, the group revokes partitions, elects or contacts the group leader, computes a new assignment, and installs it.",
  },
  {
    type: "p",
    text: "The pause is the point. Records keep arriving while consumers stop fetching, so lag grows at the produce rate for the length of the pause. The protocol decides the blast radius. Eager assignment revokes every partition from every member, so the whole group stops. Cooperative assignment revokes only the partitions whose ownership must move, so unaffected members continue processing. The pause is shorter, but it is not free: the group may need more than one round to converge.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is producer to partition leader to consumer group. The broker stores records and tracks committed offsets. The group coordinator manages membership and rebalances. A member sends heartbeats to stay in the group and calls poll to fetch records. If a member stops polling for longer than max.poll.interval.ms, it is considered failed even if its heartbeat thread is alive. If heartbeats stop for longer than session.timeout.ms, the coordinator removes it. Either timeout can start another rebalance.",
  },
  {
    type: "compare",
    leftTitle: "Eager assignment",
    rightTitle: "Cooperative assignment",
    rows: [
      { label: "What is revoked", left: "Every partition from every member", right: "Only partitions that change owner" },
      { label: "Who stops", left: "The whole group", right: "The members involved in the move" },
      { label: "Rounds", left: "One revoke-then-assign barrier", right: "Usually incremental; may take more than one round" },
      { label: "Failure mode", left: "Long group-wide pause and lag spike", right: "Smaller pause, but more complex convergence and compatibility" },
    ],
  },
  {
    type: "p",
    text: "The simulation uses 6 to 24 partitions, 2 to 12 members, and 500 to 5,000 records per second per member. The pause formula is illustrative, not a Kafka benchmark. It grows with members and partitions, and cooperative assignment reduces it to roughly a fifth while keeping half the group's modeled capacity. Those values exist to make the mechanism visible; your group's pause depends on the assignor, member health, and how quickly every member rejoins.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Rebalance pause in seconds: zero when the group is stable, then the modeled pause while partitions move.",
      "Consumer lag in records: the integral of production over the pause, minus consumption after it.",
      "Processing capacity in records per second: zero during the pause, then the post-rebalance group capacity.",
      "Paused members: the blast radius. Eager pauses every member; cooperative pauses the ones whose partitions move.",
      "A flow view with the producer, the topic, and the consumer group, plus a timeline of rebalance events.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and watch the small cooperative pause. Apply 40-second pause, then compare Cooperative recovery and Timeout eviction. Run the guided experiment before moving sliders: predict which change actually shortens the pause. Watch lag and processing capacity together, not the pause alone.",
  },
  { type: "sim", simId: "rebalancing" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At six seconds a new member joined. On the eager protocol the group revoked all 24 partitions from all 12 members. Consumption went to zero for 40 seconds while the assignment was rebuilt. Production did not stop, so lag grew by 15,000 records every second, reaching 600,000 before the group resumed. The pause metric and the lag curve were two views of the same event.",
  },
  {
    type: "p",
    text: "After the rebalance, 13 members could process 39,000 records per second against 15,000 produced. Lag drained, but it took about 25 seconds to clear the backlog. Cooperative assignment changed the shape: the modeled pause fell to about nine seconds, and the members that kept their partitions continued at roughly half capacity. With 36k records per second of pre-scale capacity, that remaining 18k covered production, so no backlog formed. The timeout preset showed a second failure: a pause longer than the session timeout made the group evict a member, adding another pause on top of the first.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Consumer group state: PreparingRebalance, CompletingRebalance, and Stable, with the time spent in each.",
      "Per-member assignment and per-partition lag before and after the change; a group total hides which partitions stopped.",
      "Consumer metrics: records-consumed-rate drops, fetch rate drops, and commit latency rises during the pause.",
      "Coordinator and client logs: JoinGroup, SyncGroup, revoked partitions, and the assignor in use.",
      "Session and poll timeouts: member evictions, repeated rebalances, and members that rejoin slowly.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the group is eager or cooperative before changing capacity. Then compare the pause with session.timeout.ms and max.poll.interval.ms. Look for one slow member holding up the rebalance, and confirm that post-rebalance capacity is above the produce rate so lag can drain.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the rebalance is the cause: group state changes, consumption stops, and lag grows at the produce rate.",
      "Find the trigger: a deploy, a scaling event, a crashed member, a partition change, or a member that stopped polling.",
      "Switch to a cooperative assignor when every member supports it. Verify the assignor on the group and test a rolling restart.",
      "Scale in smaller steps and avoid changing membership while the group is already rebalancing.",
      "Fix the timeout that caused an eviction. Raise timeouts only after measuring the pause; a longer timeout delays detection of a dead member.",
      "Make poll loops return on time. Move slow work off the poll thread or reduce max.poll.records so a batch fits the interval.",
      "Verify that post-rebalance capacity exceeds the produce rate and that lag drains to the freshness target.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Cooperative assignment reduces the pause but requires client and assignor support; mixed-version groups can fall back or fail to converge.",
      "Cooperative rebalances can take more rounds, so the group may spend longer in a non-stable state even though fewer members stop.",
      "Longer session timeouts tolerate slow members but delay detection of a genuinely dead one, extending the window with fewer consumers.",
      "Shorter timeouts detect failure faster but can evict a healthy member during a garbage-collection pause, causing another rebalance.",
      "Adding consumers increases parallelism up to the partition count, then adds idle members and more rebalance work with no throughput gain.",
      "Fewer, larger partitions reduce assignment churn but limit consumer parallelism; more partitions increase rebalance cost.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "explain-rebalance-pause",
    question:
      "Adding one consumer pauses the group for 40 seconds. Walk me through what happens and where the time goes.",
    difficulty: 3,
    hints: [
      "A partition is owned by one member at a time.",
      "The protocol decides whether every partition is revoked or only the moving ones.",
    ],
    answer:
      "A membership change starts a rebalance. The coordinator moves the group into PreparingRebalance, and members stop fetching. On the eager protocol every member revokes every partition, so the whole group is idle. The leader computes a new assignment and the members rejoin and install it. The pause covers revocation, the join and sync rounds, and the slowest member's rejoin. At 15k records per second, 40 seconds is 600k records of lag even though the topic stayed healthy. A cooperative assignor would revoke only the partitions that move, so members that keep their partitions continue processing and the pause is much smaller.",
    followUps: [
      "Which metric tells you whether the pause or the drain is the bigger problem?",
      "What would make the group rebalance twice in a row?",
      "How does max.poll.interval.ms change the failure mode?",
    ],
    redFlags: [
      "Says the topic stopped accepting writes.",
      "Blames broker replication for the consumer pause.",
      "Raises the timeout without measuring the pause.",
    ],
    rubric: [
      "Describes revocation and reassignment.",
      "Distinguishes eager from cooperative blast radius.",
      "Quantifies lag from produce rate times pause.",
      "Names the timeout and rejoin factors.",
    ],
  },
  {
    id: "cooperative-cost",
    question:
      "Your team switches to cooperative assignment and the pause drops. What new operational costs should you expect?",
    difficulty: 3,
    hints: [
      "Cooperative assignment is incremental.",
      "Mixed client versions are common during a rollout.",
    ],
    answer:
      "Cooperative assignment revokes only the partitions that need a new owner, so most members keep processing. The cost is convergence: the group can need more than one rebalance round to move a partition, and during a rolling deploy some members may not support the protocol. I would verify the assignor on every member, watch group state and revoke counts, and test a canary group before changing production. I would also keep the lag and pause dashboards, because a smaller pause still creates a backlog at high throughput.",
    followUps: [
      "How would you roll the assignor change without a mixed-protocol group?",
      "What does a partition moving through an intermediate owner look like in logs?",
      "When would eager be the simpler choice?",
    ],
    redFlags: [
      "Assumes the change is free.",
      "Ignores client version compatibility.",
      "Removes lag monitoring after the pause shrinks.",
    ],
    rubric: [
      "States incremental revocation accurately.",
      "Names mixed-version and multi-round costs.",
      "Describes a safe rollout and verification.",
    ],
  },
  {
    id: "timeout-choice",
    question:
      "A consumer occasionally pauses for 30 seconds during garbage collection. How do session.timeout.ms and max.poll.interval.ms interact, and what do you change?",
    difficulty: 4,
    hints: [
      "Heartbeats and poll calls are different liveness signals.",
      "A member can be alive but not polling.",
    ],
    answer:
      "Heartbeats keep the member in the group; poll calls prove the application is making progress. If the heartbeat thread is alive, a 30-second GC pause may not breach session.timeout.ms, but it can breach max.poll.interval.ms because the member has not called poll. That triggers a leave and a rebalance. I would first reduce the work per poll with max.poll.records, move slow processing off the poll loop, and measure the real pause. If the timeout must change, I would raise max.poll.interval.ms to cover the measured pause plus margin, not raise both blindly. Raising session.timeout.ms delays detection of a truly dead member.",
    followUps: [
      "Which timeout starts the rebalance when a member stops calling poll?",
      "What happens if only the heartbeat thread is alive?",
      "How would you distinguish GC from a slow downstream call?",
    ],
    redFlags: [
      "Treats the two timeouts as the same setting.",
      "Raises timeouts without fixing the pause.",
      "Says heartbeats alone prove processing progress.",
    ],
    rubric: [
      "Separates heartbeat liveness from poll progress.",
      "Names max.poll.interval.ms as the poll-stall trigger.",
      "Fixes batch size or slow work before raising timeouts.",
      "Notes the detection cost of longer timeouts.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Group state, per-partition lag, and per-member assignment are on one dashboard.",
      "The assignor and client versions are known for every member.",
      "Session and poll timeouts are documented against the measured processing time.",
      "Scaling and deploy runbooks say how many members can change at once.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the group is rebalancing before adding or removing members.",
      "Check whether the protocol is eager or cooperative and how many members stopped.",
      "Compare the pause with the session and poll timeouts; look for repeated rebalances.",
      "Protect the downstream store while lag drains; do not restart the group mid-rebalance.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify that lag drained to the freshness target and capacity exceeds the produce rate.",
      "Review the rebalance duration, trigger, and slowest member.",
      "Test the next membership change on a canary group.",
      "Record whether a timeout change is needed or the processing loop must be fixed.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: consumer configs and group protocol",
    url: "https://kafka.apache.org/documentation/#consumerconfigs_partition.assignment.strategy",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Assignment strategies, session timeout, and poll interval behavior.",
  },
  {
    title: "KIP-429: Kafka Consumer Incremental Rebalance Protocol",
    url: "https://cwiki.apache.org/confluence/display/KAFKA/KIP-429%3A+Kafka+Consumer+Incremental+Rebalance+Protocol",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Cooperative revocation and the incremental rebalance design.",
  },
  {
    title: "Cooperative rebalancing in Kafka consumers",
    url: "https://www.confluent.io/blog/cooperative-rebalancing-in-kafka-streams-consumer-ksqldb/",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "Why cooperative assignment reduces the stop-the-world pause and what it costs.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    rebalancing: {
      model: rebalancingModel,
      presets,
      instructions:
        "Start Healthy, apply 40-second pause, then compare Cooperative recovery and Timeout eviction. Watch the pause, processing capacity, and lag together.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Pause lengths are teaching values, not Kafka benchmarks; cooperative pauses keep half the modeled capacity while moving partitions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-consumer-groups",
    "streaming-kafka-partitions",
    "streaming-partition-count",
    "streaming-keys-ordering",
    "streaming-consumer-lag",
  ],
};
