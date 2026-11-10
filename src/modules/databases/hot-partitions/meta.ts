import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-hot-partitions",
  slug: "hot-partitions",
  title: "Hot Partitions",
  track: "databases",
  order: 22,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-rds-aurora-arch"],
  tags: ["hot partition", "shard key", "tenant isolation", "skew", "capacity"],
  productionQuestion:
    "One tenant's partition receives 60% of writes and its disk is full. What do you do?",
  learningDelta:
    "A hot partition is a data-distribution problem; splitting the key or isolating the tenant changes the balance and the operational model",
  objectives: [
    "Measure skew as the hottest partition against the median, not the cluster average.",
    "Explain why adding partitions does not split one tenant's key range.",
    "Choose between key spreading, tenant isolation, and archival for a hot partition.",
    "Predict which capacity limit binds when one partition saturates.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
