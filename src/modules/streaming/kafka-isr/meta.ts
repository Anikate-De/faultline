import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-kafka-isr",
  slug: "kafka-isr",
  title: "Kafka ISR and Under-Replicated Partitions",
  track: "streaming",
  order: 32,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["streaming-producer-acks"],
  tags: ["ISR", "under-replicated", "min.insync.replicas", "acks", "broker failure"],
  productionQuestion:
    "One broker is down and partitions are under-replicated. Are writes still safe?",
  learningDelta:
    "ISR tracks in-sync replicas; min.insync.replicas and acks determine whether writes continue and whether durability is reduced",
  objectives: [
    "Read the in-sync replica set and under-replicated partition count together.",
    "Predict write acceptance when ISR falls below min.insync.replicas.",
    "Distinguish availability from durability when writes continue.",
    "Choose a response that restores replication before the next failure.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
