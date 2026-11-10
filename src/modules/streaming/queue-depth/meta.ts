import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-queue-depth",
  slug: "queue-depth",
  title: "Queue Depth vs Latency",
  track: "streaming",
  order: 31,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["foundations-littles-law"],
  tags: ["queue depth", "oldest message age", "arrival rate", "service rate", "latency"],
  productionQuestion:
    "Queue depth is 10k but latency is fine; another queue has depth 100 and is timing out. Why?",
  learningDelta:
    "Queue depth alone is ambiguous; arrival rate, service rate, and age of oldest message determine user impact",
  objectives: [
    "Explain why queue depth is not a latency signal by itself.",
    "Use oldest message age and service rate to estimate wait.",
    "Compare two queues with different depths and different drain rates.",
    "Choose the backlog metric that matches the user-facing latency budget.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
