import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-cold-secondary",
  slug: "cold-secondary",
  title: "Cold Secondaries",
  track: "mongodb",
  order: 5,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["mongodb-adding-readers"],
  tags: ["WiredTiger cache", "cold start", "read latency", "warmup", "replica"],
  productionQuestion: "A secondary has low CPU but serves reads slowly. Why?",
  learningDelta:
    "A new secondary has a cold WiredTiger cache; serving reads before it warms up increases disk I/O and latency",
  objectives: [
    "Explain why a newly started secondary can have idle CPU and slow reads at the same time.",
    "Relate WiredTiger cache size, working-set coverage, and disk read latency.",
    "Separate a cold-cache latency problem from replication lag or CPU saturation.",
    "Sequence read routing so a new member warms before it takes production traffic.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
