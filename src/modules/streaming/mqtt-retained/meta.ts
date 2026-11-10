import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-mqtt-retained",
  slug: "mqtt-retained",
  title: "MQTT Retained Messages",
  track: "streaming",
  order: 23,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["streaming-mqtt-qos"],
  tags: ["retained message", "last value", "subscribe", "broker state", "MQTT"],
  productionQuestion:
    "A dashboard reconnects and shows no values until the next publish. What do you enable?",
  learningDelta:
    "Retained messages store the last value per topic and deliver it on subscribe, trading broker state for freshness",
  objectives: [
    "Explain how a retained message differs from a queued message.",
    "Predict what a new subscriber sees with and without the retained flag.",
    "Relate publish interval to dashboard staleness when no retained value exists.",
    "State the limits of retained state across broker restarts and topic cardinality.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
