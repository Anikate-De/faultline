import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-backpressure",
  slug: "streaming-backpressure",
  title: "Backpressure in Streaming",
  track: "streaming",
  order: 10,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-backpressure"],
  tags: ["backpressure", "lag", "buffer", "throttle", "shed"],
  productionQuestion:
    "The producer outruns consumers and lag grows without bound. Where do you apply backpressure?",
  learningDelta:
    "Backpressure can throttle producers, buffer durably in the log, or shed work; the log is not infinite and lag is a debt",
  objectives: [
    "Explain why a durable log delays backpressure instead of removing it.",
    "Estimate buffer fill time from produce rate, consumer capacity, and buffer size.",
    "Compare throttling, scaling consumers, and shedding work by what each one protects.",
    "Choose a backpressure point that keeps accepted throughput and downstream state correct.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
