import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-mqtt-fanout",
  slug: "mqtt-fanout",
  title: "MQTT Fan-Out",
  track: "streaming",
  order: 24,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["streaming-mqtt-broker-scaling"],
  tags: ["fan-out", "shared subscription", "topic tree", "bridge", "broker"],
  productionQuestion:
    "One telemetry topic has 50k subscribers and the broker is overloaded. How do you fan out?",
  learningDelta:
    "MQTT fan-out is broker-bound; shared subscriptions, topic trees, and bridging distribute subscribers across brokers",
  objectives: [
    "Estimate broker load from publish rate, subscriber count, and payload size.",
    "Explain why fan-out cost grows with subscribers rather than with publishers.",
    "Compare shared subscriptions, broker bridging, and topic-tree changes by cost and delivery semantics.",
    "Choose a fan-out design that keeps per-subscriber delivery and broker CPU within budget.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
