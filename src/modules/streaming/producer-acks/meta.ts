import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-producer-acks",
  slug: "producer-acks",
  title: "Producer Acks",
  track: "streaming",
  order: 8,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["streaming-kafka-partitions"],
  tags: ["acks", "min.insync.replicas", "durability", "latency", "leader"],
  productionQuestion: "A producer returns success and the broker loses the event. What acks setting was used?",
  learningDelta:
    "acks=0/1/all trade latency for durability; acks=all with min.insync.replicas is required for strong guarantees",
  objectives: [
    "Explain what acks=0, acks=1, and acks=all wait for before returning success.",
    "Relate min.insync.replicas to the in-sync replica set and write availability.",
    "Diagnose acknowledged data loss from leader failure and replication settings.",
    "Choose an acks and min.insync.replicas pair for a stated durability target.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
