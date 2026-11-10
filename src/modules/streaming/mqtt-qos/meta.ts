import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-mqtt-qos",
  slug: "mqtt-qos",
  title: "MQTT QoS 0, 1, and 2",
  track: "streaming",
  order: 22,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-idempotency"],
  tags: ["MQTT", "QoS", "at-least-once", "exactly-once", "packet ID"],
  productionQuestion:
    "A sensor publishes telemetry and the broker restarts. Which QoS prevents loss?",
  learningDelta:
    "QoS 0 is fire-and-forget, QoS 1 is at-least-once, QoS 2 is exactly-once at the protocol level with higher overhead",
  objectives: [
    "Map QoS 0, 1, and 2 to their delivery guarantees and packet flows.",
    "Predict loss and duplication when a broker restarts at each QoS level.",
    "Explain why QoS 2 is not end-to-end exactly-once for your application.",
    "Choose a QoS level from the cost of a missing or duplicate reading.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
