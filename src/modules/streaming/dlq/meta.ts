import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-dlq",
  slug: "dlq",
  title: "Dead Letter Queues",
  track: "streaming",
  order: 14,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["streaming-poison-messages"],
  tags: ["DLQ", "replay", "alerting", "retention", "ownership"],
  productionQuestion:
    "Failed events go to a DLQ and no one notices for a week. What is missing?",
  learningDelta:
    "A DLQ is only useful with replay, alerting, ownership, and a retention policy; otherwise it becomes a data dump",
  objectives: [
    "Explain why a DLQ needs an owner and an alert, not just a destination.",
    "Compare DLQ depth with arrival rate and drain time as operating signals.",
    "Recognize the point where retention deletes failures before replay.",
    "Design a replay path that is bounded and verifiable.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
