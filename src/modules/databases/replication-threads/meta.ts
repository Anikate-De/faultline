import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-replication-threads",
  slug: "replication-threads",
  title: "Replication Thread Bottlenecks",
  track: "databases",
  order: 28,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-primary-replica-lag"],
  tags: ["replication threads", "apply lag", "I/O", "write burst", "parallel replication"],
  productionQuestion:
    "Replica CPU is low but lag grows during a write burst. Which resource is the bottleneck?",
  learningDelta:
    "Replication apply is often single-threaded or limited by I/O; more replicas do not fix a slow apply path",
  objectives: [
    "Explain why apply lag grows while replica CPU is low.",
    "Distinguish apply capacity from network and CPU capacity.",
    "Predict lag growth from write rate and apply throughput.",
    "Choose a fix that raises apply throughput instead of adding replicas.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
