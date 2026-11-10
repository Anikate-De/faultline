import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-slow-consumers",
  slug: "slow-consumers",
  title: "Slow Consumers",
  track: "streaming",
  order: 12,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["streaming-consumer-lag"],
  tags: ["slow consumer", "partition", "processing time", "downstream", "poison"],
  productionQuestion:
    "One consumer processes 10× slower than its peers. What do you check?",
  learningDelta:
    "Per-partition processing time, downstream calls, and poison records identify slow consumers; more consumers cannot split one partition",
  objectives: [
    "Find the slow consumer from per-partition lag and processing time instead of group averages.",
    "Separate a slow downstream call from a hot key and from a poison record.",
    "Explain why adding a consumer member cannot split one partition's work.",
    "Choose a fix that preserves the ordering guarantee the consumer needs.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
