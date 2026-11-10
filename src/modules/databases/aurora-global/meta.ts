import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-aurora-global",
  slug: "aurora-global",
  title: "Aurora Global Database",
  track: "databases",
  order: 4,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-rds-aurora-arch"],
  tags: ["Aurora Global", "secondary region", "storage replication", "promotion", "RPO"],
  productionQuestion:
    "You need a secondary region for disaster recovery and local reads. What does Aurora Global Database replicate?",
  learningDelta:
    "Aurora Global Database replicates storage asynchronously to secondary regions; read replicas serve local reads and promotion changes the writer",
  objectives: [
    "Explain what Aurora Global Database replicates and what stays regional.",
    "Separate storage replication lag from the recovery point objective exposed by promotion.",
    "Place local reads in a secondary Region and predict their freshness.",
    "Describe what promotion changes for writers, readers, endpoints, and other secondary clusters.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
