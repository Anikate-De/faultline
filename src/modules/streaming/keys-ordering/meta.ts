import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-keys-ordering",
  slug: "keys-ordering",
  title: "Keys and Ordering",
  track: "streaming",
  order: 2,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["streaming-kafka-partitions"],
  tags: ["key", "partition", "ordering", "hash", "skew"],
  productionQuestion: "Two updates for one order arrive out of order. What key should the producer use?",
  learningDelta:
    "Kafka preserves order within a partition; keying by entity keeps its events ordered while allowing parallelism across keys",
  objectives: [
    "Map an event key to a partition and state the ordering scope it creates.",
    "Choose a key that preserves per-entity order without collapsing the topic to one partition.",
    "Recognize when a coarse key trades ordering for partition skew.",
    "Diagnose out-of-order events from partition assignment, not consumer timing.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
