import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-rds-aurora-arch",
  slug: "rds-aurora-arch",
  title: "RDS and Aurora Architecture",
  track: "databases",
  order: 1,
  difficulty: 1,
  minutes: 16,
  prerequisites: ["foundations-consistency-models"],
  tags: ["RDS", "Aurora", "writer endpoint", "reader endpoint", "storage", "replicas"],
  productionQuestion:
    "A read query is hitting the writer and piling up locks. Which endpoint and topology should it use?",
  learningDelta:
    "RDS and Aurora separate compute from storage differently; endpoints and replicas determine where reads and writes go",
  objectives: [
    "Trace a read and a write from the application endpoint to the instance that serves it.",
    "Choose the writer, reader, or instance endpoint for a workload and explain the consequence.",
    "Compare how RDS and Aurora place storage and replicas, and what each replica can serve.",
    "Recognize reads routed to the writer as a capacity and contention problem.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
