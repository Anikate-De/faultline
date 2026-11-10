import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-consumer-groups",
  slug: "consumer-groups",
  title: "Consumer Groups and Offsets",
  track: "streaming",
  order: 3,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["streaming-kafka-partitions"],
  tags: ["consumer group", "offset", "commit", "replay", "at-least-once"],
  productionQuestion: "A consumer restarts and reprocesses 10 minutes of events. Why?",
  learningDelta:
    "Offsets are committed by the group; commit interval and processing semantics determine replay and duplicates",
  objectives: [
    "Explain what a committed offset means for a partition and a consumer group.",
    "Distinguish auto-commit from commit-after-processing by its replay and duplicate behavior.",
    "Estimate the replay window from processing rate and commit interval.",
    "Choose a commit policy and duplicate-handling strategy for at-least-once delivery.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
