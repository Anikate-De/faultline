import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-eventbridge",
  slug: "eventbridge",
  title: "SNS and EventBridge Routing",
  track: "streaming",
  order: 28,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["streaming-keys-ordering"],
  tags: ["SNS", "EventBridge", "fan-out", "rule", "pattern", "ordering"],
  productionQuestion:
    "A notification goes to five subscribers and a new event triggers three unintended consumers. What do you check?",
  learningDelta:
    "SNS fan-out and EventBridge rules solve different routing problems; broad patterns and shared buses create hidden consumers and ordering surprises",
  objectives: [
    "Distinguish SNS topic fan-out from EventBridge rule matching.",
    "Predict delivery volume from subscriptions, rules, and event rate.",
    "Diagnose hidden consumers caused by a broad event pattern.",
    "Design routing that bounds fan-out and keeps unrelated teams decoupled.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
