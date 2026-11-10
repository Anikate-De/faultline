import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-sqs-fifo",
  slug: "sqs-fifo",
  title: "SQS FIFO",
  track: "streaming",
  order: 27,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["streaming-sqs-visibility"],
  tags: ["FIFO", "message group", "ordering", "throughput", "deduplication"],
  productionQuestion:
    "You need per-customer order and high throughput. How does FIFO scale?",
  learningDelta:
    "FIFO queues preserve order within a message group; throughput scales with groups, and a hot group serializes",
  objectives: [
    "Explain how a FIFO queue orders messages within a message group.",
    "Predict throughput when consumers outnumber message groups.",
    "Diagnose a hot group that serializes despite a large consumer fleet.",
    "Redesign a group key to spread load without breaking per-customer order.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
