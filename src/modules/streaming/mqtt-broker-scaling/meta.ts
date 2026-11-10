import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-mqtt-broker-scaling",
  slug: "mqtt-broker-scaling",
  title: "MQTT Broker Scaling",
  track: "streaming",
  order: 25,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["streaming-mqtt-qos"],
  tags: ["broker cluster", "session state", "retained state", "bridge", "load balancer"],
  productionQuestion:
    "You add a broker and existing clients lose their sessions. Why?",
  learningDelta:
    "MQTT sessions and retained state are broker-local unless clustered or bridged; scaling requires state strategy",
  objectives: [
    "Explain why a load balancer does not move an existing MQTT session.",
    "Distinguish session state, subscriptions, in-flight messages, and retained state.",
    "Compare broker-local, sticky, and shared-state cluster strategies by reconnect behavior.",
    "Plan a broker addition that preserves sessions and retained values.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
